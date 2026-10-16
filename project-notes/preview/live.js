// The resident plugin's live copies for the preview: an agent directory with agents that notes started (running,
// waiting for an approval, done and unread) and the one-tap prompt list, backed by the fixture RPCs. Synthetic data.
import { NOW, quickState } from "./fixtures.js";

const ago = minutes => new Date(NOW - minutes * 60_000).toISOString();
const item = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agent = (id, itemId, launchId, patch) => ({ id, workspaceId: `wks_${id}`, provider: "claude", status: "idle", pending: [], attention: null, turn: null, title: null, createdAt: ago(90), updatedAt: ago(5),
  lastUserMessageAt: null, attentionAt: null, itemId, launchId, parentId: null, ...patch });
const agents = new Map([
  agent("agent_7c21e0", item(5), "launch-preview-1", { status: "running", title: "排查夜间构建失败", turn: "turn-1@" + ago(3), updatedAt: ago(1) }),
  agent("agent_7c21e1", null, null, { status: "running", title: "补充重试日志", parentId: "agent_7c21e0" }),
  agent("agent_51d2a4", item(6), "launch-preview-2", { status: "running", provider: "example-acp", title: "重写告警分级", pending: ["perm-1"], updatedAt: ago(2) }),
  agent("agent_93be10", item(7), "launch-preview-3", { title: "v2.4 回滚演练", attention: "finished", attentionAt: ago(12), updatedAt: ago(12) }),
].map(entry => [entry.id, entry]));

/** The shape of client/agent-directory.ts, read-only. */
export const previewDirectory = {
  ready: () => true, get: id => agents.get(id), list: () => [...agents.values()], version: () => 1,
  subscribe: () => () => {}, dispose() {},
};

const listeners = new Set();
let version = 0;
/** The shape of client/quick-store.ts over the fixture setting. */
export const previewQuick = {
  entries: () => quickState.prompts, revision: () => quickState.revision, ready: () => true, version: () => version,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  adopt(values, revision) { quickState.prompts = values.prompts; quickState.revision = revision; version++; for (const listener of [...listeners]) listener(); },
  refresh: async () => {}, dispose() {},
};
