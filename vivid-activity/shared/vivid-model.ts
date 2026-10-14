/**
 * 本地补丁（vivid-activity）的纯数据部分：类别外观、状态外观、中文标签、MCP 名称拆分、等待批准的 callId。
 * 不依赖 react-native，供客户端组件和单元测试共用。色相名对应 client/kit.tsx 的 vivid palette。
 */
export type Hue = "blue" | "sky" | "cyan" | "teal" | "green" | "lime" | "amber" | "orange" | "red" | "pink" | "fuchsia" | "violet" | "indigo" | "gray";

/** waiting: a permission request on the row (等你批准); question: the row asks you something (等你回答, 0.6.0). */
export type RowStatus = "running" | "waiting" | "question" | "completed" | "failed" | "canceled";
export type LookKey = "think" | "read" | "list" | "edit" | "write" | "shell" | "search" | "web" | "agent" | "plan" | "mcp" | "paseo" | "ask" | "skill" | "other";

/**
 * 类别色与 Agent 观测台（agent-observatory 的 laneLooks / kindLooks）一致：思考紫、读文件蓝、搜索靛、改文件绿、
 * 命令橙、联网青、子 Agent 品红、计划蓝绿、等审批琥珀、其他灰。观测台没有的类别用它没占用的色相：
 * MCP 粉、Paseo 天蓝、技能黄绿（技能浏览器同样用 Sparkles）；提问也是「在等你」，与等审批同为琥珀。
 */
export const looks: Record<LookKey, { label: string; icon: string; hue: Hue }> = {
  think: { label: "思考", icon: "Brain", hue: "violet" },
  read: { label: "读文件", icon: "FileText", hue: "blue" },
  list: { label: "列目录", icon: "FolderOpen", hue: "blue" },
  edit: { label: "改文件", icon: "FilePen", hue: "green" },
  write: { label: "写文件", icon: "FilePlus", hue: "green" },
  shell: { label: "命令", icon: "SquareTerminal", hue: "orange" },
  search: { label: "搜索", icon: "Search", hue: "indigo" },
  web: { label: "联网", icon: "Globe", hue: "cyan" },
  agent: { label: "子 Agent", icon: "Bot", hue: "fuchsia" },
  plan: { label: "计划", icon: "ListChecks", hue: "teal" },
  ask: { label: "提问", icon: "MessageCircleQuestionMark", hue: "amber" },
  mcp: { label: "MCP", icon: "Plug", hue: "pink" },
  paseo: { label: "Paseo", icon: "Workflow", hue: "sky" },
  skill: { label: "技能", icon: "Sparkles", hue: "lime" },
  other: { label: "其他", icon: "Puzzle", hue: "gray" },
};

/**
 * 0.5.0：「鲜明」调色板里上游详情视图的类别色（shared/presentation.ts 的 ActivityCategory）。图标色和底色都从这一张表取，
 * 不再各写一份：0.4 的子 Agent 图标是品红、底色却写成了绿色。null 是「其他」，用主题的弱前景色和 surface2。
 */
export const VIVID_CATEGORY_HUES = {
  reasoning: looks.think.hue,
  shell: looks.shell.hue,
  file: looks.read.hue,
  search: looks.search.hue,
  agent: looks.agent.hue,
  plan: looks.plan.hue,
  communication: looks.mcp.hue,
  unknown: null,
} as const satisfies Record<string, Hue | null>;

/** 本地补丁：折叠摘要里的类别计数名，与行标题一致（读取、编辑、命令……）。 */
export const COUNT_LABELS: Record<LookKey, string> = {
  think: "思考", read: "读取", list: "列目录", edit: "编辑", write: "写入", shell: "命令", search: "搜索", web: "联网",
  agent: "子 Agent", plan: "计划", ask: "提问", mcp: "MCP", paseo: "Paseo", skill: "技能", other: "其他",
};

export function isLookKey(value: string): value is LookKey {
  return Object.prototype.hasOwnProperty.call(looks, value);
}

export const statusLooks: Record<RowStatus, { label: string; hue: Hue | "muted"; icon: string }> = {
  running: { label: "运行中", hue: "blue", icon: "LoaderCircle" },
  waiting: { label: "等你批准", hue: "amber", icon: "Hand" },
  question: { label: "等你回答", hue: "amber", icon: "MessageCircleQuestionMark" },
  completed: { label: "完成", hue: "green", icon: "Check" },
  failed: { label: "失败", hue: "red", icon: "X" },
  canceled: { label: "已取消", hue: "muted", icon: "CircleSlash2" },
};

/** Paseo 自带工具（mcp__paseo__*）的中文名，键是上游 PASEO_TOOL_LABELS 的英文名。 */
export const PASEO_TOOL_ZH: Readonly<Record<string, string>> = {
  Speak: "朗读",
  "Create Workspace": "新建工作区",
  "List Workspaces": "列出工作区",
  "Archive Workspace": "归档工作区",
  "Rename Workspace": "重命名工作区",
  "Create Agent": "新建 Agent",
  "Send Agent Prompt": "给 Agent 发消息",
  "Get Agent Status": "查看 Agent 状态",
  "Get Agent Activity": "查看 Agent 动态",
  "List Agents": "列出 Agent",
  "Cancel Agent Run": "中断 Agent",
  "Archive Agent": "归档 Agent",
  "Kill Agent": "结束 Agent",
  "Update Agent": "修改 Agent",
  "Set Agent Session Mode": "切换 Agent 模式",
  "List Pending Permissions": "列出待审批",
  "Respond to Permission": "回复审批",
  "List Workspace Scripts": "列出工作区脚本",
  "Start Workspace Script": "启动工作区脚本",
  "Stop Workspace Script": "停止工作区脚本",
  "List Terminals": "列出终端",
  "Create Terminal": "新建终端",
  "Kill Terminal": "关闭终端",
  "Capture Terminal": "读取终端输出",
  "Send Terminal Keys": "向终端发送按键",
  "Create Schedule": "新建定时任务",
  "Create Heartbeat": "新建心跳任务",
  "Delete Heartbeat": "删除心跳任务",
  "List Schedules": "列出定时任务",
  "Inspect Schedule": "查看定时任务",
  "Pause Schedule": "暂停定时任务",
  "Resume Schedule": "恢复定时任务",
  "Delete Schedule": "删除定时任务",
  "Update Schedule": "修改定时任务",
  "Schedule Logs": "定时任务记录",
  "Run Schedule Once": "立即运行定时任务",
  "List Providers": "列出 Provider",
  "List Models": "列出模型",
  "List Agent Profiles": "列出 Agent 配置",
  "Inspect Provider": "查看 Provider",
  "List Browser Tabs": "列出浏览器标签页",
  "Create Browser Tab": "新建浏览器标签页",
  "Close Browser Tab": "关闭浏览器标签页",
  "Snapshot Browser Page": "读取页面结构",
  "Click Browser Element": "点击页面元素",
  "Fill Browser Element": "填写页面元素",
  "Hover Browser Element": "悬停页面元素",
  "Drag Browser Element": "拖动页面元素",
  "Select Browser Option": "选择下拉选项",
  "Wait for Browser Condition": "等待页面条件",
  "Type into Browser": "在浏览器输入",
  "Press Browser Key": "浏览器按键",
  "Navigate Browser": "浏览器打开网址",
  "Browser Back": "浏览器后退",
  "Browser Forward": "浏览器前进",
  "Browser Reload": "浏览器刷新",
  "Capture Browser Screenshot": "浏览器截图",
  "Upload Files in Browser": "浏览器上传文件",
  "Read Browser Logs": "读取浏览器日志",
  "Evaluate Browser JavaScript": "在浏览器执行脚本",
  "Scroll Browser": "滚动页面",
  "Resize Browser Viewport": "调整浏览器窗口",
};

/** 上游英文标签 → 中文（行标题、详情小节名）。原始工具名（MCP 工具、未知工具）属于数据，保留原文。 */
const LABELS: Record<string, string> = {
  Read: "读取", List: "列目录", "List Directory": "列目录", Edit: "编辑", Add: "新建", Delete: "删除", Write: "写入",
  Shell: "命令", Search: "搜索", Find: "查找", "Fetch URL": "抓取网页", "Agent Task": "子 Agent", Plan: "计划", Thinking: "思考",
  Skill: "技能", Tasks: "任务", "Ask Question": "提问", "Background Task": "后台任务", Speak: "朗读", "Worktree Setup": "准备工作树", Tool: "工具",
  "Search Tools": "查找工具", "Code Mode": "代码模式",
  "Supervisor Reply": "回复子 Agent", "Supervisor Queue": "子 Agent 请求队列", "Supervisor Requests": "子 Agent 请求",
  "Supervisor Status": "子 Agent 状态", "Subagent Supervisor": "子 Agent 监管",
  Wait: "等待", "Wait for Background Work": "等待后台任务", "Wait Subscription": "订阅等待", "Wait for All": "等待全部",
  "Wait for Run": "等待运行", "Bg Wait": "后台等待", "Wait for Agent": "等待 Agent",
  // 0.5.0: Pi's sub-agent tools (shared/pi-subagents.ts piSubagentPresentation).
  "Dispatch Agent": "派出子 Agent", "Steer Agent": "引导子 Agent", "Check Agent Result": "查看子 Agent 结果", "Agent Result": "子 Agent 结果",
  "GitHub Actions Details": "GitHub Actions 详情", "GitHub Actions List": "GitHub Actions 列表", "GitHub Actions Run": "GitHub Actions 运行",
  "GitHub File": "GitHub 文件", "GitHub Job Logs": "GitHub 作业日志", "GitHub Pull Request": "GitHub PR", "GitHub Code Search": "GitHub 代码搜索",
  "GitHub Repository Search": "GitHub 仓库搜索",
  "Exa Web Search": "Exa 网页搜索", "Exa Web Fetch": "Exa 抓取网页", "Exa Agent": "Exa 研究 Agent",
  "Exa Research Guide": "Exa 研究指南", "Exa Schema Templates": "Exa 结构模板",
  // Claude Code tools Paseo has no detail type for (shown by name, e.g. inside a child agent's live activity).
  TodoWrite: "更新任务", NotebookEdit: "编辑笔记本", BashOutput: "读取后台输出", KillShell: "结束后台命令", KillBash: "结束后台命令",
  WebSearch: "联网搜索", ExitPlanMode: "提交计划", EnterPlanMode: "进入计划模式", SlashCommand: "斜杠命令", AskUserQuestion: "提问",
  ListMcpResourcesTool: "列出 MCP 资源", ReadMcpResourceTool: "读取 MCP 资源",
  // Detail section labels.
  Command: "命令", Output: "输出", Contents: "内容", "Written contents": "写入内容", Before: "改前", After: "改后", Diff: "改动",
  Result: "结果", Error: "错误", Input: "输入", Image: "图片", "Setup log": "准备日志", "Activity log": "活动日志", Query: "查询",
  Matches: "匹配", Files: "文件", Message: "消息", Prompt: "提示词", Code: "代码", Session: "会话",
};

const WAIT_FOR_AGENTS = /^Wait for (\d+) Agents$/;

export function zh(label: string): string {
  const direct = LABELS[label];
  if (direct) return direct;
  if (label.startsWith("Paseo ")) {
    const paseo = PASEO_TOOL_ZH[label.slice("Paseo ".length)];
    if (paseo) return `Paseo · ${paseo}`;
  }
  const agents = WAIT_FOR_AGENTS.exec(label);
  if (agents) return `等待 ${agents[1]} 个 Agent`;
  return label;
}

type DetailLike = { type?: unknown; toolName?: unknown } | null | undefined;

/** Which look a row gets: detail type first (like the observatory's tool kinds), then well-known tool names. */
export function lookFor(name: string, detail: DetailLike, presentation: { category: string; label: string; icon: string }): LookKey {
  const leaf = name.trim().toLowerCase();
  const detailType = typeof detail?.type === "string" ? detail.type : "unknown";
  if (detailType === "shell" || detailType === "worktree_setup") return "shell";
  if (detailType === "read") return presentation.label === "List" ? "list" : "read";
  if (detailType === "edit") return presentation.label === "Add" ? "write" : "edit";
  if (detailType === "write") return "write";
  if (detailType === "search") return detail?.toolName === "web_search" ? "web" : "search";
  if (detailType === "fetch") return "web";
  if (detailType === "sub_agent") return "agent";
  if (detailType === "plan") return "plan";
  if (presentation.label === "Skill") return "skill";
  if (presentation.label === "Ask Question") return "ask";
  if (presentation.label === "Tasks") return "plan";
  if (presentation.label.startsWith("Paseo ")) return "paseo";
  if (presentation.label === "Exa Web Search" || presentation.label === "Exa Web Fetch") return "web";
  if (/^mcp__|^mcp_|\./.test(leaf) && presentation.category === "unknown") return "mcp";
  if (presentation.category === "search") return "search";
  if (presentation.category === "agent") return "agent";
  if (presentation.category === "shell") return "shell";
  if (presentation.category === "plan") return "plan";
  return "other";
}

/**
 * `mcp__github__search_code` → { server: "github", tool: "search_code" }: the server up to the first `__` after it, as
 * `/^mcp__(.+?)__(.+)$/` read it. 0.6.0-local.2 (codex-vivid-F1): found by index; the lazy regex retried past every later
 * `__` when the name held a line break.
 */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const trimmed = name.trim();
  const at = trimmed.startsWith("mcp__") && !/[\n\r\u2028\u2029]/.test(trimmed) ? trimmed.indexOf("__", 6) : -1;
  return at >= 0 && at + 2 < trimmed.length ? { server: trimmed.slice(5, at), tool: trimmed.slice(at + 2) } : null;
}

type PendingLike = { kind?: unknown; metadata?: Record<string, unknown> } | null | undefined;
/**
 * Where a permission request names the timeline row it belongs to: Claude `metadata.toolUseId`, ACP `metadata.toolCallId`,
 * Codex app-server `metadata.itemId` (0.6.0, opus-F48: its command, file-change and request_user_input requests carry only the
 * item id, and the row's callId is that same item.id), OpenCode questions `metadata.callID`. Each equals the row's callId.
 */
const ROW_ID_KEYS = ["toolUseId", "toolCallId", "itemId", "callID"] as const;

function rowIdsOf(request: PendingLike): string[] {
  const meta = request?.metadata ?? {};
  return ROW_ID_KEYS.map((key) => meta[key]).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function pendingCallIds(pending: readonly PendingLike[] | null | undefined): ReadonlySet<string> {
  return pendingCalls(pending).ids;
}

/**
 * 0.6.0 (opus-F54): the rows waiting for you, and which of them ask a question (`kind: "question"`: Claude's
 * AskUserQuestion, Codex request_user_input, OpenCode/Pi/OMP questions) rather than ask for approval. `onlyQuestions`:
 * every pending request is a question, for a row that cannot be matched by id.
 */
export function pendingCalls(pending: readonly PendingLike[] | null | undefined): { ids: ReadonlySet<string>; questions: ReadonlySet<string>; onlyQuestions: boolean } {
  const ids = new Set<string>();
  const questions = new Set<string>();
  let onlyQuestions = (pending?.length ?? 0) > 0;
  for (const request of pending ?? []) {
    const question = request?.kind === "question";
    if (!question) onlyQuestions = false;
    for (const id of rowIdsOf(request)) {
      ids.add(id);
      if (question) questions.add(id);
    }
  }
  return { ids, questions, onlyQuestions };
}

/**
 * 本地补丁：哪些动效组件需要挂载。motion.tsx 的每个动效组件都会各自注册「减弱动态效果」（和前后台）监听，
 * 并在挂载时查询一次系统设置；上游行头给每一行都挂了 Pop/Flash。这里只给真正在动的行挂：运行中的转圈与扫光、
 * 等你批准的波纹、直播中的呼吸，以及「你看着它变了」之后的弹出与闪光。静止的已完成行一个也不挂。
 */
export function rowMotion(input: { status: RowStatus; statusChanges: number; finishes: number; live: boolean }) {
  return {
    spin: input.status === "running",
    sweep: input.status === "running",
    ping: input.status === "waiting" || input.status === "question",
    breathe: input.live,
    pop: input.statusChanges > 0,
    flash: input.status === "completed" && input.finishes > 0,
  };
}

/** Row wash behind live and attention states; light themes need a little more tint to read on white. */
export function washAlpha(status: RowStatus, dark: boolean): number {
  if (status !== "running" && status !== "waiting" && status !== "question" && status !== "failed") return 0;
  return dark ? 0.14 : 0.1;
}

// 本地补丁：状态值保持英文（决定颜色），显示时换成中文。精确匹配优先（「Active」是浏览器当前标签页）。
const STATUS_ZH: Readonly<Record<string, string>> = {
  Active: "当前", Default: "默认", Success: "成功", Failed: "失败",
  running: "运行中", initializing: "启动中", starting: "启动中", loading: "加载中", completed: "已完成", succeeded: "成功",
  success: "成功", idle: "空闲", active: "启用中", healthy: "正常", ready: "就绪", available: "可用", enabled: "已启用",
  failed: "失败", error: "出错", unhealthy: "异常", unavailable: "不可用", disabled: "已停用", canceled: "已取消",
  cancelled: "已取消", paused: "已暂停", stopped: "已停止", closed: "已关闭", exited: "已退出", archived: "已归档",
  expired: "已过期", skipped: "已跳过", pending: "等待中", queued: "排队中", timeout: "超时", timed_out: "超时",
  worktree: "工作树", local: "本地", none: "不隔离", directory: "目录",
  tool: "工具", plan: "计划", question: "提问", mode: "模式", other: "其他",
  finished: "已结束", permission: "等待审批", closed_by_user: "已关闭",
  background: "后台运行",
};
export function statusLabel(value: string): string {
  return STATUS_ZH[value] ?? STATUS_ZH[value.toLowerCase()] ?? value;
}

/**
 * Words for a failed row's state pill: the shell exit code when known. Codex/ACP report `exitCode` on the detail;
 * Claude Code only puts it in the error text ("Exit code 1\n…").
 */
export function failureText(detail: { type?: unknown; exitCode?: unknown } | null | undefined, errorText: string | undefined): string | undefined {
  const fromDetail = detail?.type === "shell" && typeof detail.exitCode === "number" && detail.exitCode !== 0 ? detail.exitCode : null;
  const fromText = /^\s*Exit code (\d+)\b/i.exec(errorText ?? "")?.[1];
  const code = fromDetail ?? (fromText ? Number(fromText) : null);
  return code !== null && code !== 0 ? `退出码 ${code}` : undefined;
}

/** Screen-reader label: action, what it touched (the path as shown), and the state when it needs attention. */
export function rowLabel({ expanded, title, summary, fileDisplay, status }: { expanded: boolean; title: string; summary?: string; fileDisplay?: { dir?: string; base: string }; status?: RowStatus }): string {
  const target = fileDisplay ? (fileDisplay.dir ? `${fileDisplay.dir}/${fileDisplay.base}` : fileDisplay.base) : summary;
  const state = status === "waiting" || status === "question" || status === "failed" || status === "running" ? `，${statusLooks[status].label}` : "";
  return `${expanded ? "收起" : "展开"} ${title}${target ? ` ${target}` : ""}${state}`;
}
