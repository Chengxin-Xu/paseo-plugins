// Development-only 每轮小结 (turn summaries): synthetic recaps written as a model would, in the preview's language. Off by
// default, as on a new install; ?scenario=recaps turns them and suggested replies on.
import { fixtureTelemetry } from "./fixtures";
import { previewLanguage } from "./i18n";

const scenario = () => new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
const on = scenario() === "recaps";
export const fixtureRecapSettings = { enabled: on, suggestions: on, runner: { kind: "grok" } };
let revision = 0;
const listeners = new Set();
export function subscribeRecapSettings(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function saveRecapSettings(next) { Object.assign(fixtureRecapSettings, next); revision++; for (const listener of listeners) listener(); }

const ago = seconds => new Date(Date.now() - seconds * 1000).toISOString();
const turnOf = agentId => fixtureTelemetry.agents.find(row => row.agentId === agentId) ?? { turnStartedAt: null, turnEndedAt: null };
const texts = {
  "zh-CN": {
    "performance-baseline": ["整理性能基线：脚本和首页基线已跑完，报告待合入", "把基线脚本加进 CI", "先把基线脚本加进 CI"],
    "iteration-plan": ["规划下一轮迭代：拆成三个里程碑，等你选方案", "选拆分方案", "按方案 B 拆分"],
    "renamed-project-check": ["核对项目名称：工作区标题已改，旧路径仍在用", "确认是否迁移旧路径", null],
    "payment-root": ["重构支付服务：幂等校验已上，接口测试进行中", "补完重复请求测试", null],
    "migration-review": ["审查数据库迁移：计划已核对，等环境确认", "确认预发布环境", null],
  },
  en: {
    "performance-baseline": ["Performance baseline: scripts and home page runs done, report not merged", "Add the baseline script to CI", "Add the baseline script to CI first"],
    "iteration-plan": ["Next iteration: split into three milestones, waiting for your pick", "Pick a split", "Go with option B"],
    "renamed-project-check": ["Project names: workspace title changed, old path still in use", "Decide on the old path", null],
    "payment-root": ["Payment refactor: idempotency check in, API tests running", "Finish duplicate-request tests", null],
    "migration-review": ["Migration review: plan checked, waiting on the environment", "Confirm staging", null],
  },
};

/** The list the server would send: fresh recaps for resting Agents, older ones for Agents working again, one being written. */
export function fixtureRecapList() {
  if (!fixtureRecapSettings.enabled) return { mode: "full", revision: `recaps-off-${revision}`, enabled: false, suggestions: false, recaps: [] };
  const words = texts[previewLanguage === "zh-CN" ? "zh-CN" : "en"];
  const recaps = Object.entries(words).map(([agentId, [summary, next, reply]], index) => {
    const turn = turnOf(agentId), working = agentId === "payment-root" || agentId === "migration-review";
    return { agentId, summary, next, reply: fixtureRecapSettings.suggestions && !working ? reply : null, at: ago(60 + index * 90),
      // Agents running again describe the turn before: the server marked them out of date.
      roundAt: working ? ago(7_200) : turn.turnStartedAt, endedAt: working ? ago(6_900) : turn.turnEndedAt, stale: working, state: "idle", runner: "Grok 4.7 · low" };
  });
  recaps.push({ agentId: "mobile-bootstrap", summary: null, next: null, reply: null, at: null, roundAt: null, endedAt: null, stale: false, state: "generating", runner: "Grok 4.7 · low" });
  return { mode: "full", revision: `recaps-${revision}-${previewLanguage}`, enabled: true, suggestions: fixtureRecapSettings.suggestions, recaps };
}
export function fixtureRecapStatus() {
  return { enabled: fixtureRecapSettings.enabled, suggestions: fixtureRecapSettings.suggestions, runner: "Grok 4.7 · low", available: true, problem: null, reason: null, until: null,
    active: fixtureRecapSettings.enabled ? 1 : 0, queued: 0, lastAt: fixtureRecapSettings.enabled ? ago(60) : null, lastOutcome: fixtureRecapSettings.enabled ? "written" : null };
}
