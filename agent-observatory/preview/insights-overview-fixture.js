// Development-only synthetic 智能分析 data: 总览 roll-up, one suggestion set, analysis runners. No host data is read.
import { rawAgents } from "./fixtures";
import { grokRunnerLabel } from "../shared/insights";

const hour = 3_600_000, day = 24 * hour;
const iso = ms => new Date(ms).toISOString();
const agentOf = id => rawAgents.find(agent => agent.id === id);
const localDay = (at, offset) => new Date(at + offset * 60_000).toISOString().slice(0, 10);
/** The browser's own zone, as a device would report it; null where the runtime cannot tell. */
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
/** How a suggestion window records its clock (grok-F3): the device's zone, or UTC days for ?scenario=insights-utc. */
const windowClock = scenario => scenario === "insights-utc" ? { timeZone: null } : { timeZone: browserZone(), utcOffsetMinutes: -new Date().getTimezoneOffset() };

/** Twelve reports over nine days; three still have open high findings. */
function reports(now) {
  const make = (jobId, agentId, hoursAgo, health, findings) => ({ jobId, agentId, at: now - hoursAgo * hour, health, findings,
    title: agentOf(agentId)?.title ?? agentId, projectName: agentOf(agentId)?.projectName ?? "未关联项目" });
  return [
    make("r-payment-root-3", "payment-root", 2, "watch", [{ id: "f1", severity: "high", category: "loop", title: "同一个失败的集成测试被原样重跑 6 次", status: "open" }, { id: "f2", severity: "medium", category: "efficiency", title: "每次小改动都跑全量测试", status: "open" }]),
    make("r-release-check-2", "release-check", 5, "blocked", [{ id: "f1", severity: "high", category: "failure", title: "测试数据库连接超时，任务停在验证环节", status: "open" }, { id: "f2", severity: "medium", category: "loop", title: "连接失败后反复重试，没有改变策略", status: "open" }]),
    make("r-migration-review-1", "migration-review", 9, "watch", [{ id: "f1", severity: "medium", category: "coordination", title: "等待审批 18 分钟，期间没有推进其他检查", status: "open" }]),
    make("r-payment-idem-1", "payment-idempotency", 20, "healthy", [{ id: "f1", severity: "low", category: "quality", title: "新接口缺少并发重试的回归用例", status: "resolved" }]),
    make("r-performance-1", "performance-baseline", 30, "healthy", [{ id: "f1", severity: "low", category: "efficiency", title: "重复读取同一份基线报告", status: "false_positive" }]),
    make("r-payment-root-2", "payment-root", 44, "watch", [{ id: "f1", severity: "high", category: "loop", title: "失败后没有缩小测试范围就整体重跑", status: "resolved" }]),
    make("r-iteration-1", "iteration-plan", 60, "healthy", []),
    make("r-release-check-1", "release-check", 80, "blocked", [{ id: "f1", severity: "high", category: "failure", title: "发布流水线依赖的镜像版本未固定", status: "open" }]),
    make("r-renamed-1", "renamed-project-check", 100, "watch", [{ id: "f1", severity: "medium", category: "quality", title: "改名后仍有 3 处引用旧项目路径", status: "open" }]),
    make("r-payment-tests-1", "payment-tests", 130, "healthy", [{ id: "f1", severity: "low", category: "efficiency", title: "测试数据构造重复了 4 次", status: "resolved" }]),
    make("r-migration-draft-1", "migration-draft", 170, "watch", [{ id: "f1", severity: "medium", category: "coordination", title: "迁移草案在两个会话里各改了一版", status: "open" }]),
    make("r-validation-1", "payment-validation", 200, "healthy", []),
  ];
}

export const fixtureSuggestionsState = { jobs: [], feedback: {} };
/** Scenarios whose 智能分析 has history: the reports list and the 总览 agree. */
// ?scenario=insights-utc: the latest suggestion set was written before any device reported its zone (按 UTC 日期).
export const richInsightScenarios = new Set(["insights-rich", "insights-suggesting", "insights-suggest-failed", "insights-utc"]);

/** Full report jobs behind the roll-up, so 总览 links open real reports. */
export function fixtureReportJobs(now = Date.now()) {
  const details = { loop: "失败后没有阅读输出就原样重跑，同一个用例连续失败，耗时累积。", failure: "验证环境不可用，任务无法区分代码问题和环境问题。", efficiency: "验证范围大于改动范围，每轮都花在无关检查上。",
    coordination: "等待与并行编辑造成空转或重复劳动。", quality: "交付物缺少关键的回归检查或留有旧引用。" };
  return reports(now).map((item, index) => ({
    id: item.jobId, agentId: item.agentId, agentTitle: item.title, projectName: item.projectName, createdAt: iso(item.at - 4 * 60_000), updatedAt: iso(item.at), status: "completed",
    trigger: index % 5 === 3 ? "manual" : "auto", stage: "分析完成 · 可查看对应执行版本与证据",
    eligibility: { eligible: true, turnCount: 4 + index % 3, toolCount: 12 + index * 2, reason: "模拟会话包含足够轨迹" },
    coverage: { rows: 60 + index * 7, truncated: false, oldestAt: iso(item.at - 2 * hour), newestAt: iso(item.at), characters: 18_000 + index * 900 },
    report: { summary: `${item.title}：${item.findings.length ? `发现 ${item.findings.length} 个值得跟进的问题。` : "执行顺利，没有需要跟进的问题。"}`, health: item.health, confidence: "medium",
      findings: item.findings.map(finding => ({ id: finding.id, severity: finding.severity, category: finding.category, title: finding.title, detail: details[finding.category], evidence: [], recommendation: "先定位根因，再调整做法；把验证范围和改动范围对齐。" })),
      strengths: ["任务拆分清晰"], nextActions: item.findings.length ? ["按建议调整后做一次增量跟进"] : [], limitations: ["这是开发预览模拟数据，未调用真实 AI 模型。"] },
    evidence: [], model: "grok-4.7", effort: "xhigh", usage: { inputTokens: 52_000, outputTokens: 12_000, costUsd: null }, error: null,
    runner: { kind: "grok", label: "Grok 4.7 · xhigh", provider: null, model: "grok-4.7", thinkingOptionId: "xhigh", modeId: null, sessionAgentId: null },
    findingFeedback: Object.fromEntries(item.findings.filter(finding => finding.status !== "open").map(finding => [finding.id, { status: finding.status, updatedAt: iso(item.at + hour) }])),
  }));
}

function suggestionJob(now, days, extra = {}, scenario = null) {
  const all = reports(now).filter(item => item.at >= now - days * day);
  const ref = (jobId, findingId) => { const report = all.find(item => item.jobId === jobId); const finding = report?.findings.find(item => item.id === findingId);
    return report ? { jobId, findingId: finding ? findingId : null, agentId: report.agentId, agentTitle: report.title, projectName: report.projectName, title: finding?.title ?? "整份报告", severity: finding?.severity ?? null, category: finding?.category ?? null } : null; };
  const evidence = Object.fromEntries([["R1", ref("r-payment-root-3")], ["R1#f1", ref("r-payment-root-3", "f1")], ["R1#f2", ref("r-payment-root-3", "f2")], ["R2#f1", ref("r-release-check-2", "f1")],
    ["R2#f2", ref("r-release-check-2", "f2")], ["R3#f1", ref("r-migration-review-1", "f1")], ["R6#f1", ref("r-payment-root-2", "f1")], ["R8#f1", ref("r-release-check-1", "f1")],
    ["R11#f1", ref("r-migration-draft-1", "f1")]].filter(([, value]) => value));
  return {
    id: "fixture-suggestions-1", createdAt: iso(now - 40 * 60_000), updatedAt: iso(now - 35 * 60_000), status: "completed", trigger: "manual", stage: "建议已生成",
    window: { days, from: localDay(now - (days - 1) * day, 0), to: localDay(now, 0), reports: all.length, findings: all.reduce((sum, item) => sum + item.findings.length, 0), agents: new Set(all.map(item => item.agentId)).size,
      ...windowClock(scenario) },
    runner: { kind: "grok", label: "Grok 4.7 · xhigh", provider: null, model: "grok-4.7", thinkingOptionId: "xhigh", modeId: null, sessionAgentId: null },
    usage: { inputTokens: 48_200, outputTokens: 6_900, costUsd: null }, error: null, basis: all.map(item => item.jobId), evidence,
    feedback: fixtureSuggestionsState.feedback,
    report: {
      headline: "测试失败后原样重跑是最大的时间黑洞，两个项目的验证环境不稳定",
      summary: "近几天的报告里，Agent 在测试失败后倾向于原样重跑，而不是先缩小范围或检查环境；发布检查被数据库连接超时卡住两次。审批等待和并行草案造成了少量重复劳动。好的一面是：拆分子任务和补测试的习惯已经稳定。下一步最值得做的是给重跑设上限，并把测试数据库固定成可复用的本地实例。",
      themes: [
        { id: "t1", title: "失败后原样重跑", detail: "3 份报告中出现同一模式：集成测试失败后不看日志就整体重跑，最多连续 6 次，占用了约 40 分钟。", category: "loop", severity: "high", trend: "recurring", evidence: ["R1#f1", "R2#f2", "R6#f1"] },
        { id: "t2", title: "验证环境不稳定", detail: "Delivery Systems 的测试数据库连接超时两次，镜像版本未固定，导致发布检查无法得出结论。", category: "failure", severity: "high", trend: "new", evidence: ["R2#f1", "R8#f1"] },
        { id: "t3", title: "审批与并行编辑的等待", detail: "迁移相关任务等待审批期间没有推进其他检查；同一份草案被两个会话分别修改。", category: "coordination", severity: "medium", trend: "improving", evidence: ["R3#f1", "R11#f1"] },
      ],
      actions: [
        { id: "a1", title: "限制同一失败命令的重跑次数", why: "原样重跑同一个失败的测试是最常见的低效模式（3 份报告，累计约 40 分钟）。写成规则后，Agent 会在第二次失败时先读日志、缩小范围或改变策略。", steps: ["把规则加进项目的 AGENTS.md / CLAUDE.md", "在「实现」Profile 的说明里同步一句", "一周后在总览里看「重复与循环」是否下降"],
          scope: "instructions", impact: "high", effort: "small", projects: ["Commerce Platform", "Delivery Systems"], evidence: ["R1#f1", "R2#f2", "R6#f1"],
          instruction: "同一条命令连续失败两次后，不要再原样重跑：先阅读失败输出，定位到具体用例或原因，缩小到受影响的测试再运行；如果怀疑是环境问题，先检查环境并在回复里说明。", task: null },
        { id: "a2", title: "给集成测试准备可复用的本地测试数据库", why: "发布检查两次卡在数据库连接超时，Agent 无法区分代码问题和环境问题。一个可一键启动、带健康检查的测试数据库能让验证稳定下来。", steps: ["提供 docker compose 或脚本启动测试数据库", "在测试前加健康检查与清晰的失败提示", "在 README 写明启动方式"],
          scope: "tooling", impact: "high", effort: "medium", projects: ["Delivery Systems"], evidence: ["R2#f1", "R8#f1"], instruction: null,
          task: "在 Delivery Systems 项目中为集成测试提供一个可复用的本地测试数据库：\n1. 增加一条命令（脚本或 docker compose）启动测试数据库，并在启动后做健康检查；\n2. 集成测试开始前检查数据库连通性，连不上时给出明确的错误提示而不是超时；\n3. 在 README 的测试章节写明用法。\n验收：连续运行 3 次 `npm run test:integration` 都能通过或给出明确的环境错误。" },
        { id: "a3", title: "把「只跑受影响的测试」写进实现 Profile", why: "小改动也跑全量测试拖慢了每一轮验证。让 Agent 先跑受影响的测试、合并前再跑全量，可以把单轮时间降一半左右。", steps: ["更新「实现 · 长程执行与交付」Profile 的说明", "项目里提供按文件运行测试的命令"],
          scope: "profile", impact: "medium", effort: "small", projects: ["Commerce Platform"], evidence: ["R1#f2"], instruction: "改动后先运行与改动文件相关的测试；在准备提交或合并前再运行一次完整测试，并在回复里写明两次的结果。", task: null },
        { id: "a4", title: "长时间等审批时先推进不需要审批的检查", why: "迁移审查等待审批 18 分钟时处于空转。提示 Agent 在等待期间继续做只读检查，可以减少整体用时。", steps: ["在迁移类任务的提示里说明可以先做的只读检查", "对常用的只读命令开启预先批准"],
          scope: "workflow", impact: "medium", effort: "small", projects: ["Commerce Platform"], evidence: ["R3#f1"], instruction: null, task: null },
      ],
      wins: ["大任务拆成子 Agent 并行推进的做法已经稳定，支付重构的 3 个子任务都按时完成", "补测试的习惯在变好：并发重试的回归用例已补上并被标记为已解决"],
      watch: ["Delivery Systems 连续两份报告存在阻塞", "迁移草案有两个会话在改，合并前需要核对"],
    },
    ...extra,
  };
}

function summary(job) {
  const status = id => job.feedback?.[id]?.status ?? "open";
  return { id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status, trigger: job.trigger, stage: job.stage, window: job.window, runnerLabel: job.runner.label, error: job.error,
    headline: job.report?.headline ?? null, themes: job.report?.themes.length ?? 0, actions: job.report?.actions.length ?? 0,
    openActions: job.report ? job.report.actions.filter(action => ["open", "adopted"].includes(status(action.id))).length : 0 };
}

export function fixtureSuggestions(now, scenario, days = 7) {
  if (!richInsightScenarios.has(scenario)) return { job: null, history: fixtureSuggestionsState.jobs.map(summary) };
  const job = suggestionJob(now, days, {}, scenario);
  const extra = fixtureSuggestionsState.jobs.map(summary);
  return { job, history: [...extra, summary(job)] };
}

export function fixtureOverview(days, offset, scenario, settings, runnerLabel) {
  const now = Date.now();
  if (!richInsightScenarios.has(scenario)) {
    return { generatedAt: iso(now), days, utcOffsetMinutes: offset, timeZone: browserZone(), from: localDay(now - (days - 1) * day, offset), to: localDay(now, offset), autoEnabled: settings.autoEnabled, runnerLabel,
      totals: { reports: 0, agents: 0, projects: 0, auto: 0, manual: 0, failedRuns: 0, openFindings: 0, resolvedFindings: 0, dismissedFindings: 0, highOpen: 0, tokens: null },
      health: { healthy: 0, watch: 0, blocked: 0 }, daily: Array.from({ length: days }, (_, index) => ({ day: localDay(now - (days - 1 - index) * day, offset), healthy: 0, watch: 0, blocked: 0 })),
      categories: ["failure", "loop", "efficiency", "coordination", "quality"].map(category => ({ category, high: 0, medium: 0, low: 0, open: 0, resolved: 0 })),
      projects: [], agents: [], findings: [], suggestions: null, suggestionJob: null, nextSuggestionAt: null, reportsSinceSuggestions: 0 };
  }
  const all = reports(now).filter(item => item.at >= now - days * day);
  const findings = all.flatMap(report => report.findings.map(finding => ({ ...finding, report })));
  const count = status => findings.filter(item => item.status === status).length;
  const daily = Array.from({ length: days }, (_, index) => { const key = localDay(now - (days - 1 - index) * day, offset), items = all.filter(item => localDay(item.at, offset) === key);
    return { day: key, healthy: items.filter(item => item.health === "healthy").length, watch: items.filter(item => item.health === "watch").length, blocked: items.filter(item => item.health === "blocked").length }; });
  const categories = ["failure", "loop", "efficiency", "coordination", "quality"].map(category => { const rows = findings.filter(item => item.category === category);
    return { category, high: rows.filter(item => item.severity === "high").length, medium: rows.filter(item => item.severity === "medium").length, low: rows.filter(item => item.severity === "low").length,
      open: rows.filter(item => item.status === "open").length, resolved: rows.filter(item => item.status === "resolved").length }; });
  const latest = new Map(); for (const report of all) if (!latest.has(report.agentId)) latest.set(report.agentId, report);
  const agents = [...latest.values()].map(report => { const open = report.findings.filter(item => item.status === "open");
    return { agentId: report.agentId, title: report.title, projectName: report.projectName, reports: all.filter(item => item.agentId === report.agentId).length, health: report.health,
      openFindings: open.length, highOpen: open.filter(item => item.severity === "high").length, lastJobId: report.jobId, lastAt: iso(report.at) }; })
    .filter(item => item.openFindings || item.health !== "healthy").sort((a, b) => b.highOpen - a.highOpen || b.openFindings - a.openFindings).slice(0, 12);
  const rank = { high: 0, medium: 1, low: 2 };
  const open = [...latest.values()].flatMap(report => report.findings.filter(item => item.status === "open").map(item => ({ jobId: report.jobId, findingId: item.id, agentId: report.agentId, agentTitle: report.title,
    projectName: report.projectName, title: item.title, category: item.category, severity: item.severity, status: item.status, at: iso(report.at) }))).sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at)).slice(0, 16);
  const projects = [...new Set(all.map(item => item.projectName))].map(name => { const items = all.filter(item => item.projectName === name), rows = items.flatMap(item => item.findings);
    return { name, reports: items.length, openFindings: rows.filter(item => item.status === "open").length, highOpen: rows.filter(item => item.status === "open" && item.severity === "high").length,
      blocked: items.filter(item => item.health === "blocked").length, lastAt: iso(Math.max(...items.map(item => item.at))) }; }).sort((a, b) => b.openFindings - a.openFindings);
  const suggestions = fixtureSuggestions(now, scenario, days);
  const running = scenario === "insights-suggesting" ? { ...summary(suggestionJob(now, days, { id: "fixture-suggestions-running", status: "analyzing", stage: "Grok 4.7 · xhigh 正在读 12 份报告，寻找跨 Agent 的模式", report: null, createdAt: iso(now - 60_000), updatedAt: iso(now) })) } : null;
  const failed = scenario === "insights-suggest-failed" ? summary(suggestionJob(now, days, { id: "fixture-suggestions-failed", status: "failed", stage: "分析未完成", error: "模拟：分析模型没有返回合法的 JSON。", report: null, createdAt: iso(now - 5 * 60_000) })) : null;
  return { generatedAt: iso(now), days, utcOffsetMinutes: offset, timeZone: browserZone(), from: localDay(now - (days - 1) * day, offset), to: localDay(now, offset), autoEnabled: settings.autoEnabled, runnerLabel,
    totals: { reports: all.length, agents: latest.size, projects: projects.length, auto: all.length - 2, manual: 2, failedRuns: 1, openFindings: count("open"), resolvedFindings: count("resolved"),
      dismissedFindings: count("false_positive"), highOpen: findings.filter(item => item.status === "open" && item.severity === "high").length, tokens: all.length * 64_000 },
    health: { healthy: all.filter(item => item.health === "healthy").length, watch: all.filter(item => item.health === "watch").length, blocked: all.filter(item => item.health === "blocked").length },
    daily, categories, projects: projects.slice(0, 12), agents, findings: open,
    suggestions: suggestions.job ? summary(suggestions.job) : null, suggestionJob: running ?? failed ?? (suggestions.job ? summary(suggestions.job) : null),
    nextSuggestionAt: settings.autoEnabled ? iso(now + 14 * hour) : null, reportsSinceSuggestions: 2 };
}

export const fixtureRunners = {
  auto: { runner: { kind: "auto" }, label: "自动选择", detail: "有 Grok CLI 时用它；否则用已启用的 Claude Code 或 Codex（包括 extends 它们的自定义 Provider）和它的默认模型", providerLabel: "现在：Grok 4.7 · xhigh", modelLabel: null, thinkingLabel: null, available: true, reason: null, access: "none", modeId: null },
  builtin: { runner: { kind: "grok" }, label: "Grok 4.7 · xhigh", detail: "Grok CLI：不提供工具，工具调用一律拒绝；会话和它的会话搜索记录在分析结束后立即删除", providerLabel: null, modelLabel: "grok-4.7", thinkingLabel: "xhigh", available: true, reason: null, access: "none", modeId: null },
  profiles: [
    { runner: { kind: "profile", profileId: "daily" }, label: "日常 · Opus 5.5", detail: "常规问答、代码阅读、一般分析", providerLabel: "Claude Code", modelLabel: "Opus 5.5", thinkingLabel: "high", available: true, reason: "没有只读模式：需要审批的工具请求会被自动拒绝，不需要审批的操作（例如读取文件）仍可能执行", access: "ask", modeId: "default" },
    { runner: { kind: "profile", profileId: "implement" }, label: "实现 · 长程执行与交付", detail: "目标和验收明确的编码、重构、迁移", providerLabel: "Codex", modelLabel: "GPT-5 Codex", thinkingLabel: "high", available: true, reason: null, access: "read", modeId: "auto" },
    { runner: { kind: "profile", profileId: "explore" }, label: "探索 · 并行查证", detail: "另一条独立的并行探索或分析任务", providerLabel: "OpenCode", modelLabel: "kimi-k2", thinkingLabel: null, available: false, reason: "OpenCode 暂不可用", access: "read", modeId: "plan" },
  ],
  providers: [
    { provider: "claude", label: "Claude Code", available: true, reason: null, access: "ask", modeId: "default", defaultModel: "claude-opus-5-5" },
    { provider: "codex", label: "Codex", available: true, reason: null, access: "read", modeId: "auto", defaultModel: "gpt-5-codex" },
    { provider: "opencode", label: "OpenCode", available: true, reason: null, access: "read", modeId: "plan", defaultModel: "kimi-k2" },
  ],
};
const thinking = ids => ids.map(id => ({ id, label: { low: "低", medium: "中", high: "高", max: "最大", xhigh: "超高" }[id] ?? id }));
export function fixtureModels(provider) {
  const models = {
    claude: [{ id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, thinking: thinking(["low", "medium", "high", "max"]), defaultThinkingOptionId: "high" },
      { id: "claude-fable-5-1", label: "Fable 5.1", isDefault: false, thinking: thinking(["medium", "high", "max"]), defaultThinkingOptionId: "high" },
      { id: "claude-sonnet-5", label: "Sonnet 5", isDefault: false, thinking: thinking(["low", "medium", "high"]), defaultThinkingOptionId: "medium" }],
    codex: [{ id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true, thinking: thinking(["low", "medium", "high", "xhigh"]), defaultThinkingOptionId: "high" },
      { id: "gpt-5", label: "GPT-5", isDefault: false, thinking: thinking(["low", "medium", "high"]), defaultThinkingOptionId: "medium" }],
    opencode: [{ id: "kimi-k2", label: "Kimi K2", isDefault: true, thinking: [], defaultThinkingOptionId: null }],
  }[provider];
  if (!models) throw new Error(`模拟 Provider ${provider} 不存在`);
  return { provider, models };
}
export const fixtureProfiles = [
  { id: "daily", name: "日常 · Opus 5.5", provider: "claude", model: "claude-opus-5-5", modeId: "default", thinkingOptionId: "high" },
  { id: "implement", name: "实现 · 长程执行与交付", provider: "codex", model: "gpt-5-codex", modeId: "full-access", thinkingOptionId: "high" },
];
export function runnerLabelFor(runner) {
  if (!runner || runner.kind === "auto") return "自动选择 · Grok 4.7 · xhigh";
  if (runner.kind === "grok") return grokRunnerLabel(runner);
  if (runner.kind === "profile") return fixtureRunners.profiles.find(item => item.runner.profileId === runner.profileId)?.label ?? `Profile ${runner.profileId}（不可用）`;
  const provider = fixtureRunners.providers.find(item => item.provider === runner.provider);
  const model = runner.model ? fixtureModels(runner.provider).models.find(item => item.id === runner.model)?.label ?? runner.model : "默认模型";
  return `${provider?.label ?? runner.provider} · ${model}${runner.thinkingOptionId ? ` · ${runner.thinkingOptionId}` : ""}`;
}
