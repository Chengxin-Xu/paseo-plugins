// Synthetic server-browser state for the preview: four existing browsers in three projects, no network, no daemon.
import pr from "./fixtures/pr.jpg";
import docs from "./fixtures/docs.jpg";
import login from "./fixtures/login.jpg";
import demo from "./fixtures/demo.jpg";

const params = new URLSearchParams(location.search);
export const scenario = params.get("scenario") || "default";
const now = Date.now();
const images = { pr, docs, login, demo };
const pages = {
  pr: { title: "fix: 断线重连后保留草稿 · Pull Request #128 · acme/web-app", url: "https://git.example.com/acme/web-app/pull/128" },
  docs: { title: "快速上手 · Acme Docs", url: "https://docs.example.com/guide/getting-started" },
  login: { title: "统一身份认证 · 登录", url: "https://sso.example.com/login?next=%2Fadmin" },
  demo: { title: "服务器浏览器 · 互动体验", url: "about:blank" },
};
const workspaces = [
  { id: "ws-review", title: "feat/checkout-redesign", cwd: "/home/user/projects/web-app", projectId: "p-web", projectTitle: "acme/web-app" },
  { id: "ws-release", title: "release/2.4", cwd: "/home/user/projects/web-app-release", projectId: "p-web", projectTitle: "acme/web-app" },
  { id: "ws-demo", title: "shared-demo", cwd: "/home/user/projects/demo-project", projectId: "p-demo", projectTitle: "demo-project" },
  { id: "ws-admin", title: "admin-console", cwd: "/home/user/projects/commerce", projectId: "p-commerce", projectTitle: "Commerce Platform" },
  { id: "ws-docs", title: "main", cwd: "/home/user/projects/docs-site", projectId: "p-docs", projectTitle: "docs-site" },
  { id: "ws-mobile", title: "移动端页面优化", cwd: "/home/user/projects/mobile-shop", projectId: "p-mobile", projectTitle: "mobile-shop" },
];
const agents = {
  "agent-review": { id: "agent-review", title: "浏览器验收 Agent", status: "running", provider: "claude", needsPermission: false },
  "agent-release": { id: "agent-release", title: "发布检查 Agent", status: "idle", provider: "codex", needsPermission: false },
  "agent-admin": { id: "agent-admin", title: "审查数据库迁移脚本", status: "running", provider: "claude", needsPermission: true },
};
const settings = { autoRecover: true, maxTabs: 20, maxArtifactMB: 256, artifactMaxAgeHours: 48 };
const runtime = (uptime, recoveries = 0) => ({ recoveryCount: recoveries, lastRecoveredAt: recoveries ? now - 3 * 3600_000 : null, lastFailure: recoveries ? "Target page, context or browser has been closed" : null, artifactBytes: 38_400_000, artifactCount: 27, cleanedArtifacts: 0, uptimeSeconds: uptime });
const tab = (id, page, active, pinned = false) => ({ id, title: pages[page].title, url: pages[page].url, active, pinned, page });
const activity = (id, source, action, status, page, minutesAgo, tabId) => ({ id, source, action, status, tabId, pageTitle: pages[page].title, pageUrl: pages[page].url, startedAt: now - minutesAgo * 60_000, endedAt: status === "running" ? null : now - minutesAgo * 60_000 + 1800 });
const sessions = new Map();
function add(workspaceId, value) { sessions.set(workspaceId, { workspaceId, status: "running", mode: "agent", width: 1120, height: 720, agentId: null, error: null, agentBusy: false, settings: { ...settings }, health: null, ...value }); }
if (!["empty", "none", "offline"].includes(scenario)) {
  add("ws-review", { agentId: "agent-review", agentBusy: scenario !== "calm", tabs: [tab("t-pr", "pr", true), tab("t-docs", "docs", false)], runtime: runtime(5_400),
    activity: [activity("a4", "agent", "browser_click", "running", "pr", 0, "t-pr"), activity("a3", "agent", "browser_snapshot", "completed", "pr", 1, "t-pr"), activity("a2", "agent", "browser_navigate", "completed", "pr", 3, "t-pr"), activity("a1", "manual", "navigate", "failed", "docs", 26, "t-docs")] });
  if (scenario !== "single") {
    add("ws-release", { agentId: "agent-release", tabs: [tab("t-rel", "docs", true)], runtime: runtime(12_000, 1), activity: [activity("b1", "agent", "browser_navigate", "completed", "docs", 44, "t-rel")] });
    add("ws-demo", { mode: "manual", tabs: [tab("t-demo", "demo", true, true), tab("t-demo-docs", "docs", false)], runtime: runtime(86_000), activity: [] });
    add("ws-admin", { agentId: "agent-admin", tabs: [tab("t-sso", "login", true)], runtime: runtime(900), activity: [],
      health: { state: "login_required", summary: "页面疑似需要登录", checkedAt: now - 120_000, httpStatus: 200, origin: "https://sso.example.com" } });
  }
  if (scenario === "recovering") Object.assign(sessions.get("ws-review"), { status: "recovering", agentBusy: false });
}
const frameVersion = new Map();
// Page context like the server's inputScope: a tab, navigation, mode or device change ends live input; typing does not.
const scopeVersion = new Map();
// The page itself like the server's documentScope: a navigation or tab change replaces it, control and typing do not.
const documentVersion = new Map();
const inputStreams = new Map(), inputSeqs = new Map();
// Like the server's inputSeqFloor: a viewer without a record must number its batches above it (set by tests before load).
globalThis.__inputSeqFloor = globalThis.__inputSeqFloor ?? {};
globalThis.__browserCalls = [];
globalThis.__browserRelease = {};
// What live input reached each page: typed text, keys as ⟨Enter⟩, clicks as ⟨click⟩.
globalThis.__typed = {};
// Ports Agents opened (browser.ports): this workspace's and one in another workspace. `?scenario=noports` is a host that
// cannot list them (not Linux): the group stays hidden. __browserFixture.addPort() adds one while a sheet is open.
const port = (value, process, agentTitle, agentStatus, scope, workspaceId, extra = {}) => ({ port: value, scope, process, agentId: `agent-port-${value}`, agentTitle, agentStatus, workspaceId, workspaceTitle: workspaces.find(item => item.id === workspaceId)?.title ?? null, projectTitle: workspaces.find(item => item.id === workspaceId)?.projectTitle ?? null, openable: true, ...extra });
const agentPorts = [
  port(3000, "node", "前端开发 Agent", "running", "local", "ws-demo"),
  port(6006, "node", "组件库 Agent", "closed", "all", "ws-demo"),
  port(8000, "python3", "数据接口 Agent", "idle", "address", "ws-demo", { address: "192.0.2.10" }),
  port(4321, "node", "浏览器验收 Agent", "running", "local", "ws-review"),
];
function portsReply(input) {
  if (scenario === "noports") return { supported: false, items: [], others: [], scannedAt: Date.now(), revision: "unsupported" };
  const body = { supported: true, items: agentPorts.filter(item => item.workspaceId === input.workspaceId), others: agentPorts.filter(item => item.workspaceId !== input.workspaceId), partial: false, uncertain: false, failed: false };
  const revision = hash(stable(body));
  return input.revision === revision ? { supported: true, unchanged: true, revision, scannedAt: Date.now() } : { ...body, revision, scannedAt: Date.now() };
}
const services = { "ws-demo": [{ name: "web", port: 5173, url: "http://127.0.0.1:5173/", running: true, health: "healthy" }, { name: "api", port: 8787, url: "http://127.0.0.1:8787/", running: true, health: "unhealthy" }, { name: "storybook", port: null, url: null, running: false, health: null }] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const latency = scenario === "slow" ? 900 : 60;

function stable(value) { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
function hash(text) { let value = 2166136261; for (let index = 0; index < text.length; index++) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); } return (value >>> 0).toString(36); }
function scope(session) { return `${session.workspaceId}:${session.tabs.find(item => item.active)?.id ?? ""}:${session.mode}:${scopeVersion.get(session.workspaceId) ?? 0}`; }
function documentScope(session) { return `doc:${session.workspaceId}:${session.tabs.find(item => item.active)?.id ?? ""}:${documentVersion.get(session.workspaceId) ?? 0}`; }
function newDocument(workspaceId) { documentVersion.set(workspaceId, (documentVersion.get(workspaceId) ?? 0) + 1); }
function publicSession(session) { const { tabs, ...rest } = session; return { activeTabId: tabs.find(item => item.active)?.id ?? null, viewRevision: String(frameVersion.get(session.workspaceId) ?? 0), inputScope: scope(session), documentScope: documentScope(session), inputSeqFloor: globalThis.__inputSeqFloor[session.workspaceId] ?? 0, devicePreset: "desktop", viewerCount: 2, dialog: null, agentAvailability: session.agentId && !agents[session.agentId] ? "unavailable" : "available", ...rest, title: tabs.find(item => item.active)?.title ?? "", url: tabs.find(item => item.active)?.url ?? "", tabs: tabs.map(({ page: _page, ...item }) => item) }; }
function idle(workspaceId) { return { workspaceId, status: "idle", title: "", url: "", mode: "manual", width: 1120, height: 720, tabs: [], agentId: null, error: null, agentBusy: false, settings: { ...settings }, health: null, activity: [] }; }
function state(workspaceId) { const session = sessions.get(workspaceId); return session ? publicSession(session) : idle(workspaceId); }
function overviewItems() {
  return [...sessions.values()].map(session => {
    const full = publicSession(session), workspace = workspaces.find(item => item.id === session.workspaceId);
    return { workspace, session: { ...full, tabs: [], settings: undefined, runtime: undefined, activity: (full.activity ?? []).filter(item => item.status === "running") }, agent: full.agentId ? agents[full.agentId] ?? null : null, observedAt: now };
  });
}
function active(session) { return session.tabs.find(item => item.active); }
function bump(workspaceId) { frameVersion.set(workspaceId, (frameVersion.get(workspaceId) ?? 0) + 1); }
function endInput(workspaceId) { scopeVersion.set(workspaceId, (scopeVersion.get(workspaceId) ?? 0) + 1); bump(workspaceId); }
function pageFor(url) { return /\/pull\//.test(url) ? "pr" : /sso|login/.test(url) ? "login" : url === "about:blank" ? "demo" : "docs"; }
function requireRunning(workspaceId) { const session = sessions.get(workspaceId); if (!session || session.status !== "running") throw new Error("请先启动服务器浏览器。"); return session; }

function act(workspaceId, action, target) {
  const session = requireRunning(workspaceId);
  if (action.kind === "takeover") {
    if (!target || target.tabId !== active(session)?.id || (target.documentScope && target.documentScope !== documentScope(session))) throw new Error("确认之前页面已经变化，这次没有切到手动，也没有执行。请看清当前页面后再操作。");
    if (session.mode !== "manual") { session.mode = "manual"; endInput(workspaceId); }
    return act(workspaceId, action.then, { tabId: active(session).id, viewRevision: String(frameVersion.get(workspaceId) ?? 0), inputScope: scope(session) });
  }
  if (session.mode !== "manual" && !["mode", "settings", "cleanup"].includes(action.kind)) throw new Error("当前由 Agent 操作，请先切换到手动。");
  const current = active(session);
  const fresh = target && target.tabId === current?.id && (target.inputScope && action.kind !== "click" ? target.inputScope === scope(session) : target.viewRevision === String(frameVersion.get(workspaceId) ?? 0));
  if (!["mode", "stop", "restart", "settings", "cleanup", "handleDialog"].includes(action.kind) && !fresh) throw new Error("画面已变化，这次操作未执行，已刷新当前页面。");
  const before = scope(session);
  if (["navigate", "back", "forward", "reload", "demo", "newTab", "tab", "closeTab", "devicePreset", "viewport"].includes(action.kind)) newDocument(workspaceId);
  if (action.kind === "openPort") { const listed = agentPorts.find(item => item.port === action.port && item.openable); if (!listed) throw new Error(`端口 ${action.port} 不在 Agent 开的端口列表里，没有打开。请刷新列表再试。`); return act(workspaceId, { kind: "newTab", url: `http://127.0.0.1:${action.port}/` }, target); }
  switch (action.kind) {
    case "mode": session.mode = action.mode; break;
    case "navigate": { const url = /^[a-z]+:/i.test(action.url) ? action.url : `https://${action.url}`; const page = pageFor(url); Object.assign(current, { url, title: page === "docs" ? `${new URL(url).hostname} · 网页` : pages[page].title, page }); break; }
    case "tab": for (const item of session.tabs) item.active = item.id === action.tabId; break;
    case "closeTab": { const index = session.tabs.findIndex(item => item.id === action.tabId); if (session.tabs[index]?.pinned) throw new Error("该标签页已固定，请先在面板取消固定。"); session.tabs.splice(index, 1); if (!session.tabs.some(item => item.active) && session.tabs[0]) session.tabs[0].active = true; break; }
    case "newTab": { for (const item of session.tabs) item.active = false; const created = { ...tab(`t-new-${session.tabs.length + 1}`, "demo", true) }; if (action.url) Object.assign(created, { url: action.url, title: `${new URL(action.url).host} · 开发服务`, page: "docs" }); session.tabs.push(created); break; }
    case "pin": { const target = session.tabs.find(item => item.id === action.tabId); if (target) target.pinned = action.pinned; break; }
    case "handleDialog": session.dialog = null; break;
    case "devicePreset": { const dimensions = { iphone: [393, 659], pixel: [412, 839], ipad: [834, 1194], desktop: [1440, 900] }[action.preset]; session.devicePreset = action.preset; session.width = dimensions[0]; session.height = dimensions[1]; break; }
    case "viewport": session.width = action.width; session.height = action.height; break;
    case "demo": Object.assign(current, { ...pages.demo, page: "demo" }); break;
    case "stop": sessions.delete(workspaceId); return idle(workspaceId);
    case "settings": session.settings = { ...session.settings, ...action.settings }; break;
    case "cleanup": session.runtime = { ...session.runtime, cleanedArtifacts: session.runtime.cleanedArtifacts + 4, artifactCount: session.runtime.artifactCount - 4, artifactBytes: session.runtime.artifactBytes - 9_600_000 }; break;
    default: break;
  }
  session.activity = [{ id: `m-${Date.now()}`, source: "manual", action: action.kind, status: "completed", tabId: active(session)?.id ?? null, pageTitle: active(session)?.title ?? "", pageUrl: active(session)?.url ?? "", startedAt: Date.now(), endedAt: Date.now() }, ...(session.activity ?? [])].slice(0, 12);
  if (!["settings", "cleanup", "handleDialog"].includes(action.kind)) { if (["mode", "pin"].includes(action.kind) && before === scope(session)) bump(workspaceId); else endInput(workspaceId); }
  return publicSession(session);
}

/**
 * Live input as the server takes it: keys continue on the page context, a click needs the exact picture. A dialog that is
 * already open runs nothing; `__dialogOnEnter[workspaceId]` makes an Enter open one, which holds that Enter (pending).
 */
function liveInput(request) {
  const session = requireRunning(request.workspaceId), current = active(session), previous = inputStreams.get(request.workspaceId);
  const reply = (status, applied = 0, continuation = null, pending = false) => ({ status, applied, continuation, pending, session: publicSession(session) });
  const seqKey = `${request.workspaceId}:${request.viewerId}`;
  const last = inputSeqs.get(seqKey);
  if (last !== undefined ? request.seq <= last : request.seq <= (globalThis.__inputSeqFloor[request.workspaceId] ?? 0)) return reply("stale");
  if (session.mode !== "manual" || request.target.tabId !== current?.id) return reply("stale");
  if (session.dialog) return reply("blocked");
  const [first] = request.events;
  if (first.kind === "click" ? request.target.viewRevision !== String(frameVersion.get(request.workspaceId) ?? 0) : request.target.inputScope !== scope(session)) return reply("stale");
  if (previous && previous.viewerId !== request.viewerId) scopeVersion.set(request.workspaceId, (scopeVersion.get(request.workspaceId) ?? 0) + 1);
  inputStreams.set(request.workspaceId, { viewerId: request.viewerId, seq: request.seq }); inputSeqs.set(seqKey, request.seq);
  const show = event => event.kind === "text" ? event.text : event.kind === "key" ? `⟨${event.key}⟩` : event.kind === "click" ? "⟨click⟩" : "";
  const opener = globalThis.__dialogOnEnter?.[request.workspaceId] ? request.events.findIndex(event => event.kind === "key" && event.key === "Enter") : -1;
  const ran = opener >= 0 ? request.events.slice(0, opener + 1) : request.events;
  globalThis.__typed[request.workspaceId] = (globalThis.__typed[request.workspaceId] ?? "") + ran.map(show).join("");
  bump(request.workspaceId);
  if (opener >= 0) { delete globalThis.__dialogOnEnter[request.workspaceId]; session.dialog = { id: "dialog-enter", tabId: current.id, type: "confirm", message: "确定提交吗？", defaultValue: "", openedAt: Date.now() }; endInput(request.workspaceId); return reply("blocked", opener, null, true); }
  return reply("applied", request.events.length, scope(session));
}

export async function rpc(name, input) {
  globalThis.__browserCalls.push({ name, input });
  await pause(latency);
  while (scenario === "hold" && name === "browser.action" && !globalThis.__browserRelease[input.action.kind]) await pause(20);
  if (scenario === "offline" && ["browser.options", "browser.overview"].includes(name)) throw new Error("Request failed: disconnected requestType=plugin code=offline");
  switch (name) {
    case "browser.orphans": return { items: scenario === "orphans" ? [{ workspaceId: "archived-workspace", kind: "process", status: "running", pid: 12345, desiredRunning: true, label: "acme/web-app / feat/old-checkout", profileBytes: 186_000_000, lastUsedAt: Date.now() - 3 * 86400_000 }, ...(globalThis.__deletedProfiles?.includes("wks_gone") ? [] : [{ workspaceId: "wks_gone", kind: "profile", status: "idle", pid: null, desiredRunning: false, label: "docs-site / fix/typo", profileBytes: 64_500_000, lastUsedAt: Date.now() - 12 * 86400_000 }])] : [] };
    case "browser.orphan.stop": return { stopped: true };
    case "browser.orphan.delete": (globalThis.__deletedProfiles ??= []).push(input.workspaceId); return { deleted: true };
    case "browser.services": return { items: services[input.workspaceId] ?? [] };
    case "browser.ports": return portsReply(input);
    case "browser.input": return liveInput(input);
    case "browser.options": return { workspaces: scenario === "none" ? [] : workspaces, profiles: [{ id: "claude-browser", name: "Claude · 浏览器", provider: "claude", model: "opus" }, { id: "codex-browser", name: "Codex · 浏览器", provider: "codex", model: null }] };
    case "browser.overview": {
      const items = overviewItems(), revision = hash(stable(items.map(({ observedAt: _observedAt, ...item }) => item)));
      return input.revision === revision ? { unchanged: true, revision, checkedAt: Date.now() } : { items, revision, checkedAt: Date.now() };
    }
    case "browser.state": return state(input.workspaceId);
    case "browser.start": { if (!sessions.has(input.workspaceId)) add(input.workspaceId, { mode: "manual", tabs: [tab("t-start", "demo", true)], runtime: runtime(0), activity: [] }); sessions.get(input.workspaceId).status = "running"; return state(input.workspaceId); }
    case "browser.frame": {
      if (scenario === "frame-error") throw new Error("Request failed: timed out requestType=plugin code=timeout");
      const session = sessions.get(input.workspaceId), full = state(input.workspaceId), revision = hash(stable(full));
      const known = input.sessionRevision === revision;
      if (!session || session.status !== "running") return known ? { sessionRevision: revision, frame: null } : { session: full, sessionRevision: revision, frame: null };
      const page = active(session)?.page ?? "demo", id = `${input.workspaceId}:${active(session)?.id}:${frameVersion.get(input.workspaceId) ?? 0}`;
      const scale = input.maxWidth ? Math.max(0.25, Math.min(1, Math.ceil(Math.min(input.maxWidth / session.width, (input.maxHeight ?? Infinity) / session.height) * 8) / 8)) : 1;
      const frame = input.after === id ? null : { id, tabId: active(session)?.id ?? "", viewRevision: String(frameVersion.get(input.workspaceId) ?? 0), inputScope: scope(session), documentScope: documentScope(session), dataUrl: images[page], width: session.width, height: session.height, capturedAt: Date.now(), ...(scale < 1 ? { scale } : {}) };
      return known ? { sessionRevision: revision, frame } : { session: full, sessionRevision: revision, frame };
    }
    case "browser.action": return act(input.workspaceId, input.action, input.target);
    case "browser.agent": {
      const session = requireRunning(input.workspaceId);
      if (session.agentAvailability === "unknown") throw new Error("暂时无法确认 Agent 状态，请稍后刷新。");
      if (session.agentId && agents[session.agentId]) return { agentId: session.agentId, created: false, session: publicSession(session) };
      const agentId = `agent-${input.workspaceId}`; agents[agentId] = { id: agentId, title: "浏览器 Agent", status: "idle", provider: "claude", needsPermission: false }; session.agentId = agentId; session.agentAvailability = "available";
      return { agentId, created: true, session: publicSession(session) };
    }
    case "browser.diagnostics": {
      const session = requireRunning(input.workspaceId), login = active(session)?.page === "login";
      const health = login ? { state: "login_required", summary: "页面疑似需要登录", checkedAt: Date.now(), httpStatus: 200, origin: "https://sso.example.com" } : { state: "accessible", summary: "页面可以访问", checkedAt: Date.now(), httpStatus: 200, origin: "https://git.example.com" };
      session.health = health;
      return { session: publicSession(session), health, checks: [{ name: "Chromium 与 CDP", status: "ok", detail: "浏览器进程与调试连接正常。" }, { name: "持久 Profile", status: "ok", detail: "登录目录可读写，已保留 Cookie。" }, { name: "字体与运行库", status: "ok", detail: "Chromium 已正常启动；字体：系统字体；运行库：系统。" }, { name: "Agent 工具", status: "ok", detail: "已找到 Playwright MCP，浏览器 Agent 可以连接。" }, { name: "网络与代理", status: "ok", detail: "未配置代理，Chromium 直接使用服务器网络。" }] };
    }
    case "browser.read": {
      const current = active(requireRunning(input.workspaceId));
      return { tabId: current.id, title: current.title, url: current.url, format: "markdown", method: input.mode === "article" ? "readability" : "dom", truncated: false, characters: 164,
        content: input.query ? `…网络切换后，编辑中的任务**草稿**会被刷新覆盖…\n\n…恢复后提示用户合并差异…` : "# fix: 断线重连后保留草稿\n\n网络切换后，编辑中的任务草稿会被刷新覆盖。本 PR 在重新连接前把草稿写入本地缓存，恢复后提示用户合并差异。\n\n验收：错误可见、草稿不丢失、重复提交只执行一次。" };
    }
    default: throw new Error(`未模拟 RPC: ${name}`);
  }
}

// Explicit synthetic control for race and lifecycle UI tests; never connects to a daemon.
globalThis.__browserFixture = {
  // An Agent starts listening while a sheet is open: the row appears on the next poll and flashes once.
  addPort(value = 5174, workspaceId = "ws-demo") { agentPorts.push(port(value, "node", "新服务 Agent", "running", "local", workspaceId)); },
  switchTab(workspaceId) { const session = sessions.get(workspaceId); session.tabs.forEach(item => { item.active = !item.active; }); newDocument(workspaceId); endInput(workspaceId); },
  // Another device or the Agent loads a new document in the same tab.
  pageChanged(workspaceId) { const session = sessions.get(workspaceId), current = active(session); Object.assign(current, { url: "https://docs.example.com/guide/next-steps", title: "下一步 · 文档", page: "docs" }); newDocument(workspaceId); endInput(workspaceId); },
  // Another device's input: this viewer's queued keys belong to a page it no longer sees.
  otherViewer(workspaceId) { inputStreams.set(workspaceId, { viewerId: "other-device", seq: 1 }); scopeVersion.set(workspaceId, (scopeVersion.get(workspaceId) ?? 0) + 1); bump(workspaceId); },
  stop(workspaceId) { sessions.delete(workspaceId); },
  start(workspaceId) { add(workspaceId, { mode: "manual", width: 1440, height: 900, tabs: [tab("t-external", "docs", true)], runtime: runtime(0), activity: [] }); },
  dialog(workspaceId, type = "prompt") { const session = sessions.get(workspaceId); session.dialog = { id: "dialog-fixture", tabId: active(session).id, type, message: "请输入发布备注", defaultValue: "已完成验收", openedAt: Date.now() }; endInput(workspaceId); },
  agentUnavailable(workspaceId, unknown = false) { const session = sessions.get(workspaceId); if (unknown) session.agentAvailability = "unknown"; else { delete agents[session.agentId]; session.agentAvailability = "unavailable"; } },
};
