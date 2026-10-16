import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeLabelHost, labelKey, labelOf, SidebarLabels, type LabelHost, type WorkspaceLabel } from "../server/sidebar-labels";
import { createProviderSubagentBridge } from "../server/provider-subagents";
import type { AttentionPhase } from "../shared/attention";
import { bindTranslator, createTranslator } from "../shared/i18n";
import en from "../shared/locales/en.json";
import kitEn from "../shared/locales/kit/en.json";
import zh from "../shared/locales/zh-CN.json";
import kitZh from "../shared/locales/kit/zh-CN.json";

// 同步到侧栏标签 (2.17): the plugin writes each workspace's 需要处理 reason as a native label and takes away only what it wrote.

/** A fake host with the 0.11.1 rules: assignment appends, a catalog entry keeps its first colour, pins carry a time. */
function fakeHost(workspaces: Record<string, { labels: string[]; pinnedAt?: string | null }>, options: { unsupported?: boolean } = {}) {
  const catalog = new Map<string, WorkspaceLabel>(), calls: string[] = [];
  let pins = 0;
  for (const workspace of Object.values(workspaces)) for (const name of workspace.labels) if (!catalog.has(labelKey(name))) catalog.set(labelKey(name), { name, color: "blue" });
  const host: LabelHost = {
    async workspace(id) { const workspace = workspaces[id]; return workspace ? { labels: [...workspace.labels], pinnedAt: workspace.pinnedAt ?? null } : null; },
    async catalog() { if (options.unsupported) throw new Error("Unknown message type: workspace.label.list.request"); return [...catalog.values()].map(label => label.name); },
    async assign(workspaceId, label, assigned) {
      calls.push(`${assigned ? "+" : "-"}${workspaceId}:${label.name}`);
      const workspace = workspaces[workspaceId];
      if (!workspace) throw new Error("Workspace not found");
      if (!catalog.has(labelKey(label.name)) && assigned) catalog.set(labelKey(label.name), label);
      const at = workspace.labels.findIndex(name => labelKey(name) === labelKey(label.name));
      if (assigned && at === -1) workspace.labels.push(catalog.get(labelKey(label.name))!.name);
      if (!assigned && at !== -1) workspace.labels.splice(at, 1);
    },
    async pin(workspaceId, pinned) {
      calls.push(`${pinned ? "pin" : "unpin"}:${workspaceId}`);
      const workspace = workspaces[workspaceId];
      if (!workspace) throw new Error("Workspace not found");
      workspace.pinnedAt = pinned ? `2026-10-15T12:00:${String(++pins).padStart(2, "0")}.000Z` : null;
      return workspace.pinnedAt;
    },
    async affected(name) { return Object.values(workspaces).filter(workspace => workspace.labels.some(label => labelKey(label) === labelKey(name))).length; },
    async remove(name) { calls.push(`delete:${name}`); catalog.delete(labelKey(name)); },
  };
  return { host, calls, catalog, workspaces };
}

async function sync(host: LabelHost, phases: Record<string, AttentionPhase>, options: { known?: boolean; file?: string } = {}) {
  const view = { phases: new Map(Object.entries(phases)), ready: true, known: options.known ?? true };
  const file = options.file ?? join(await mkdtemp(join(tmpdir(), "obs-labels-")), "sidebar-labels.json");
  const labels = new SidebarLabels({ host: () => host, waiting: async () => view, file, delayMs: 3_600_000 });
  return { labels, view, file };
}
const name = (phase: AttentionPhase) => labelOf(phase).name;

test("labels are the observatory's words in its colours", () => {
  assert.deepEqual(labelOf("approval"), { name: "待审批", color: "amber" });
  assert.deepEqual(labelOf("question"), { name: "提问", color: "violet" });
  assert.deepEqual(labelOf("error"), { name: "出错", color: "red" });
  assert.deepEqual(labelOf("quota"), { name: "额度用尽", color: "orange" });
  assert.deepEqual(labelOf("unread"), { name: "未读", color: "pink" });
  assert.equal(labelKey("  Plan   Review "), "plan review");
});

test("a reason becomes a label after the user's own, changes with the reason and comes off when it clears; user labels are never touched", async () => {
  const fake = fakeHost({ w1: { labels: ["未完成待推进"] }, w2: { labels: [] } });
  const { labels, view, file } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["未完成待推进", name("approval")]);
  assert.deepEqual(labels.status(), { state: "on", labels: 1, pins: 0, error: null });
  // Unchanged reasons write nothing.
  fake.calls.length = 0;
  await labels.pass();
  assert.deepEqual(fake.calls, []);
  view.phases.set("w1", "question");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["未完成待推进", name("question")]);
  view.phases.delete("w1");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["未完成待推进"], "the user's label stays");
  assert.deepEqual(fake.workspaces.w2!.labels, []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).labels, {});
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await labels.close();
});

test("a label of the same name the user put there is theirs: not added twice, never taken off", async () => {
  const fake = fakeHost({ w1: { labels: ["待审批"] } });
  const { labels, view } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  assert.deepEqual(fake.calls, []);
  view.phases.delete("w1");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["待审批"]);
  assert.equal(labels.status().labels, 0);
  await labels.close();
});

test("a user label added after the plugin's keeps the user's in front once the plugin writes there again", async () => {
  const fake = fakeHost({ w1: { labels: [] } });
  const { labels, view } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  fake.workspaces.w1!.labels.push("我的标签");
  view.phases.set("w1", "error");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["我的标签", name("error")]);
  // The same reason again after the user moved things: the plugin's label goes back to the end.
  fake.workspaces.w1!.labels.push("另一个");
  view.phases.set("w1", "question");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["我的标签", "另一个", name("question")]);
  await labels.close();
});

test("a label of the plugin's the user took off is forgotten, not put back for the same reason", async () => {
  const fake = fakeHost({ w1: { labels: [] } });
  const { labels, view } = await sync(fake.host, { w1: "unread" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  fake.workspaces.w1!.labels = [];
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, [], "same reason: left alone");
  view.phases.set("w1", "approval");
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, [name("approval")], "a new reason is written");
  await labels.close();
});

test("pins: the plugin pins a waiting workspace and unpins only its own pin; a workspace the user pinned is left as it is", async () => {
  const fake = fakeHost({ mine: { labels: [] }, theirs: { labels: [], pinnedAt: "2026-10-01T00:00:00.000Z" }, repinned: { labels: [] } });
  const { labels, view } = await sync(fake.host, { mine: "approval", theirs: "question", repinned: "error" });
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  assert.ok(fake.workspaces.mine!.pinnedAt);
  assert.equal(fake.workspaces.theirs!.pinnedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(labels.status().pins, 2);
  // The user unpinned and pinned again: that pin is theirs now.
  fake.workspaces.repinned!.pinnedAt = "2026-10-15T13:00:00.000Z";
  view.phases.clear();
  await labels.pass();
  assert.equal(fake.workspaces.mine!.pinnedAt, null, "its own pin comes off");
  assert.equal(fake.workspaces.theirs!.pinnedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(fake.workspaces.repinned!.pinnedAt, "2026-10-15T13:00:00.000Z");
  assert.equal(labels.status().pins, 0);
  await labels.close();
});

test("turning it off takes the plugin's labels and pins away, and the catalog entries it created that nobody uses", async () => {
  const fake = fakeHost({ w1: { labels: ["mine"] }, w2: { labels: [] }, w3: { labels: [] } });
  const { labels, file } = await sync(fake.host, { w1: "approval", w2: "quota", w3: "quota" });
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  // The user uses the plugin's 额度用尽 on a workspace of their own choosing: that catalog entry stays.
  fake.workspaces.w4 = { labels: [name("quota")] };
  labels.configure({ labels: false, pin: true });
  await labels.pass();
  assert.deepEqual([fake.workspaces.w1!.labels, fake.workspaces.w2!.labels, fake.workspaces.w3!.labels, fake.workspaces.w4!.labels], [["mine"], [], [], [name("quota")]]);
  assert.deepEqual([fake.workspaces.w1!.pinnedAt, fake.workspaces.w2!.pinnedAt], [null, null]);
  assert.ok(fake.calls.includes(`delete:${name("approval")}`), "an entry it created and nobody uses is removed");
  assert.ok(!fake.calls.includes(`delete:${name("quota")}`), "one in use stays");
  assert.ok(fake.catalog.has(labelKey("mine")));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, labels: {}, pins: {}, created: [] });
  assert.equal(labels.status().state, "off");
  await labels.close();
});

test("ownership survives a reload: a new instance on the same file still cleans up what the old one wrote", async () => {
  const fake = fakeHost({ w1: { labels: [] } });
  const first = await sync(fake.host, { w1: "error" });
  first.labels.configure({ labels: true, pin: false });
  await first.labels.pass();
  await first.labels.close();
  const second = await sync(fake.host, { w1: "error" }, { file: first.file });
  second.labels.configure({ labels: false, pin: false });
  await second.labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, []);
  await second.labels.close();
});

test("a partial directory read clears nothing; a gone workspace is forgotten; a daemon without labels says so", async () => {
  const fake = fakeHost({ w1: { labels: [] } });
  const { labels, view } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  view.phases.clear(); view.known = false;
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, [name("approval")], "missing from a cut read proves nothing");
  view.known = true;
  delete fake.workspaces.w1;
  await labels.pass();
  assert.equal(labels.status().labels, 0);
  await labels.close();
  const old = fakeHost({ w1: { labels: [] } }, { unsupported: true });
  const unsupported = await sync(old.host, { w1: "approval" });
  unsupported.labels.configure({ labels: true, pin: false });
  await unsupported.labels.pass();
  assert.equal(unsupported.labels.status().state, "unsupported");
  assert.deepEqual(old.calls, []);
  await unsupported.labels.close();
});

test("the bridge speaks the host's 0.11.1 label and pin requests over the plugin's own session", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let listener: ((message: unknown) => void) | null = null;
  const bridge = createProviderSubagentBridge({
    send(message) {
      const envelope = message as { data: string }, frame = JSON.parse(envelope.data) as { message: Record<string, unknown> };
      sent.push(frame.message);
      const { type, requestId } = frame.message as { type: string; requestId: string };
      const reply = type === "workspace.pin.set.request" ? { type: "workspace.pin.set.response", payload: { requestId, workspaceId: "w1", accepted: true, pinnedAt: "2026-10-15T12:00:00.000Z", error: null } }
        : type === "workspace.label.list.request" ? { type: "workspace.label.list.response", payload: { requestId, labels: [{ name: "待审批", color: "amber" }], sync: {} } }
        : type === "workspace.label.assignment.set.request" ? { type: "rpc_error", payload: { requestId, requestType: type, code: "workspace_not_found", error: "Workspace not found" } }
        : { type: type.replace(/\.request$/, ".response"), payload: { requestId, affectedWorkspaceCount: 0 } };
      queueMicrotask(() => listener?.({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: reply }) }));
    },
    listen(next) { listener = next; return () => { listener = null; }; },
  });
  const host = bridgeLabelHost(bridge, { workspaces: { ref: () => ({ refresh: async () => ({ labels: ["x"], pinnedAt: null }) }) } } as never);
  assert.deepEqual(await host.catalog(), ["待审批"]);
  assert.equal(await host.pin("w1", true), "2026-10-15T12:00:00.000Z");
  await assert.rejects(host.assign("w1", { name: "提问", color: "violet" }, true), /Workspace not found/);
  assert.equal(await host.affected("提问"), 0);
  assert.deepEqual(await host.workspace("w1"), { labels: ["x"], pinnedAt: null });
  assert.deepEqual(sent.map(message => message.type), ["workspace.label.list.request", "workspace.pin.set.request", "workspace.label.assignment.set.request", "workspace.label.delete.inspect.request"]);
  assert.deepEqual({ ...sent[2], requestId: undefined }, { type: "workspace.label.assignment.set.request", workspaceId: "w1", label: { name: "提问", color: "violet" }, assigned: true, requestId: undefined });
  bridge.dispose();
});

test("a language change alone rewrites nothing (devices in two languages would rename back and forth); the next reason is in the new one", async () => {
  const fake = fakeHost({ w1: { labels: ["发布前检查"] }, w2: { labels: [] } });
  const { labels, view, file } = await sync(fake.host, { w1: "question", w2: "question" });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["发布前检查", "提问"]);
  try {
    bindTranslator(createTranslator("en", [en, kitEn]));
    fake.calls.length = 0;
    await labels.pass();
    assert.equal(fake.calls.length, 0, "same reason: the label keeps its words");
    view.phases.set("w1", "approval");
    await labels.pass();
    assert.deepEqual(fake.workspaces.w1!.labels, ["发布前检查", "Approval"], "the old words go with the old reason");
    assert.ok(fake.catalog.has(labelKey("提问")), "still on w2: the old entry stays in the picker");
    view.phases.delete("w2");
    await labels.pass();
    assert.deepEqual(fake.workspaces.w2!.labels, []);
    assert.ok(!fake.catalog.has(labelKey("提问")), "the last one gone: the old-language entry the plugin created leaves the picker");
    assert.ok(fake.calls.includes("delete:提问"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).created, ["Approval"]);
    view.phases.delete("w1");
    await labels.pass();
    assert.deepEqual(fake.workspaces.w1!.labels, ["发布前检查"]);
    assert.ok(fake.catalog.has(labelKey("Approval")), "a name in the current language stays in the picker for the next time");
  } finally {
    bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
    await labels.close();
  }
});

test("an ownership file that cannot be written stops new labels and pins (nothing the plugin could not take back) and says so (B7)", async () => {
  const fake = fakeHost({ w1: { labels: ["发布前检查"] } });
  const folder = await mkdtemp(join(tmpdir(), "obs-labels-unwritable-"));
  const file = join(folder, "sidebar-labels.json");
  await mkdir(file); // the file's place is taken: every save fails (as with a full or read-only disk)
  const logs: string[] = [];
  const view = { phases: new Map<string, AttentionPhase>([["w1", "approval"]]), ready: true, known: true };
  const labels = new SidebarLabels({ host: () => fake.host, waiting: async () => view, file, delayMs: 3_600_000, log: line => logs.push(line) });
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  assert.deepEqual(fake.workspaces.w1, { labels: ["发布前检查"] }, "no label and no pin went to the host");
  assert.deepEqual(fake.calls, []);
  const status = labels.status();
  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /记不下观测台加过哪些标签（E[A-Z]+）/);
  assert.equal(status.labels + status.pins, 0);
  assert.ok(logs.some(line => /could not save the ownership file \(E[A-Z]+\)/.test(line)) && !logs.some(line => line.includes(folder)), "the log names the error code, not the path");
  // A reload while it cannot be written, then 关掉: nothing of the plugin's is left on the host.
  await labels.close();
  const again = new SidebarLabels({ host: () => fake.host, waiting: async () => view, file, delayMs: 3_600_000 });
  again.configure({ labels: false, pin: false });
  await again.pass();
  assert.deepEqual(fake.workspaces.w1, { labels: ["发布前检查"] });
  await again.close();
  // Writable again: the next pass writes and keeps what it wrote.
  await rm(file, { recursive: true });
  const fixed = new SidebarLabels({ host: () => fake.host, waiting: async () => view, file, delayMs: 3_600_000 });
  fixed.configure({ labels: true, pin: true });
  await fixed.pass();
  assert.deepEqual(fake.workspaces.w1!.labels, ["发布前检查", name("approval")]);
  assert.ok(fake.workspaces.w1!.pinnedAt);
  assert.deepEqual(fixed.status(), { state: "on", labels: 1, pins: 1, error: null });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).labels, { w1: [name("approval")] });
  await fixed.close();
});

test("the file failing after a pin: the pin is kept in memory (关掉 still undoes it in this run) and the pass stops there (B7)", async () => {
  const fake = fakeHost({ w1: { labels: [] }, w2: { labels: [] } });
  const folder = await mkdtemp(join(tmpdir(), "obs-labels-late-"));
  const file = join(folder, "sidebar-labels.json");
  const view = { phases: new Map<string, AttentionPhase>([["w1", "question"], ["w2", "question"]]), ready: true, known: true };
  const labels = new SidebarLabels({ host: () => fake.host, waiting: async () => view, file, delayMs: 3_600_000 });
  // The disk fills up right after the first pin.
  const pin = fake.host.pin.bind(fake.host);
  fake.host.pin = async (workspaceId, pinned) => { const at = await pin(workspaceId, pinned); if (pinned) { await rm(file, { force: true }); await mkdir(file); } return at; };
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  assert.ok(fake.workspaces.w1!.pinnedAt, "w1 was pinned before the file failed");
  assert.deepEqual(fake.workspaces.w2, { labels: [] }, "nothing new for w2 once it failed");
  assert.equal(labels.status().state, "error");
  labels.configure({ labels: false, pin: false });
  await labels.pass();
  assert.equal(fake.workspaces.w1!.pinnedAt, null, "turned off in the same run: its own pin and label come off");
  assert.deepEqual(fake.workspaces.w1!.labels, []);
  await labels.close();
});

test("a label write whose answer is lost (the real bridge times out) stays the plugin's: taken off when the reason clears and when turned off (A2)", async () => {
  const workspaces: Record<string, { labels: string[]; pinnedAt: string | null }> = { w1: { labels: ["发布前检查"], pinnedAt: null } };
  const catalog = new Map<string, WorkspaceLabel>([[labelKey("发布前检查"), { name: "发布前检查", color: "sky" }]]);
  let listener: (message: unknown) => void = () => {};
  let dropNextAssign = true;
  // The daemon applies every write, but the answer to the first label assignment never arrives.
  const bridge = createProviderSubagentBridge({
    listen(next) { listener = next; return () => {}; },
    send(envelope) {
      const { message } = JSON.parse((envelope as { data: string }).data) as { message: Record<string, any> };
      const reply = (type: string, payload: Record<string, unknown>) => setImmediate(() => listener({ type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: { type, payload: { requestId: message.requestId, ...payload } } }) }));
      if (message.type === "workspace.label.list.request") return reply("workspace.label.list.response", { labels: [...catalog.values()] });
      if (message.type === "workspace.label.assignment.set.request") {
        const workspace = workspaces[message.workspaceId]!, key = labelKey(message.label.name);
        if (message.assigned && !catalog.has(key)) catalog.set(key, message.label);
        const at = workspace.labels.findIndex(name => labelKey(name) === key);
        if (message.assigned && at === -1) workspace.labels.push(message.label.name);
        if (!message.assigned && at !== -1) workspace.labels.splice(at, 1);
        if (message.assigned && dropNextAssign) { dropNextAssign = false; return; }
        return reply("workspace.label.assignment.set.response", { label: message.label, workspaceLabels: workspace.labels });
      }
      if (message.type === "workspace.label.delete.inspect.request") return reply("workspace.label.delete.inspect.response", { affectedWorkspaceCount: Object.values(workspaces).filter(w => w.labels.some(name => labelKey(name) === labelKey(message.name))).length });
      if (message.type === "workspace.label.delete.request") { catalog.delete(labelKey(message.name)); return reply("workspace.label.delete.response", {}); }
    },
  }, 150);
  const paseo = { workspaces: { ref: (id: string) => ({ refresh: async () => workspaces[id] ? { labels: [...workspaces[id]!.labels], pinnedAt: workspaces[id]!.pinnedAt } : null }) } };
  const phases = new Map<string, AttentionPhase>([["w1", "approval"]]);
  const labels = new SidebarLabels({ host: () => bridgeLabelHost(bridge, paseo as never), waiting: async () => ({ phases, ready: true, known: true }),
    file: join(await mkdtemp(join(tmpdir(), "obs-labels-lost-")), "sidebar-labels.json"), delayMs: 3_600_000 });
  labels.configure({ labels: true, pin: false });
  await labels.pass();
  assert.deepEqual(workspaces.w1!.labels, ["发布前检查", name("approval")], "the daemon put it on; its answer was lost");
  const status = labels.status();
  assert.equal(status.labels, 1, "still the plugin's");
  assert.equal(status.error, "Paseo 没有回应，这次写入可能已经生效");
  assert.doesNotMatch(JSON.stringify(status), /子任务/, "never the bridge's subtask wording");
  await labels.pass();
  assert.equal(labels.status().error, null, "the next pass finds it there and keeps it");
  phases.delete("w1");
  await labels.pass();
  assert.deepEqual(workspaces.w1!.labels, ["发布前检查"], "the reason cleared: it comes off");
  phases.set("w1", "question");
  dropNextAssign = true;
  await labels.pass();
  labels.configure({ labels: false, pin: false });
  await labels.pass();
  assert.deepEqual(workspaces.w1!.labels, ["发布前检查"], "turned off: off too, the user's label stays");
  assert.deepEqual([...catalog.keys()], [labelKey("发布前检查")], "and the catalog entries it created");
  await labels.close();
  bridge.dispose();
});

test("a pin is the plugin's only on the host's confirmation: after one that failed or whose answer was lost, the user's own pin survives turning it off (BR1)", async () => {
  const fake = fakeHost({ w1: { labels: [] }, w2: { labels: [] }, w3: { labels: [] } });
  const pin = fake.host.pin.bind(fake.host);
  let mode: "busy" | "lost" | "ok" = "busy";
  fake.host.pin = async (workspaceId, pinned) => {
    if (!pinned || mode === "ok") return pin(workspaceId, pinned);
    // Never sent (the bridge was busy), or applied by the daemon with its answer lost (the session reconnected).
    if (mode === "busy") throw Object.assign(new Error("插件正忙"), { code: "busy" });
    fake.workspaces[workspaceId]!.pinnedAt = new Date().toISOString();
    throw Object.assign(new Error("宿主未响应：插件会话已重新连接，请重试。"), { code: "closed" });
  };
  const { labels, view } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  assert.equal(fake.workspaces.w1!.pinnedAt ?? null, null, "busy: never pinned");
  assert.equal(labels.status().pins, 0);
  // Right after, the user pins it themselves.
  fake.workspaces.w1!.pinnedAt = new Date().toISOString();
  const userPin = fake.workspaces.w1!.pinnedAt;
  // The answer to w2's pin is lost; the user unpins and pins it again a moment later.
  mode = "lost";
  view.phases.set("w2", "question");
  await labels.pass();
  assert.ok(fake.workspaces.w2!.pinnedAt, "the daemon pinned it");
  assert.equal(labels.status().pins, 0, "not claimed without the host's answer");
  fake.workspaces.w2!.pinnedAt = null;
  fake.workspaces.w2!.pinnedAt = new Date(Date.now() + 5).toISOString();
  const userRepin = fake.workspaces.w2!.pinnedAt;
  // A confirmed pin (w3) is the plugin's and comes off as before.
  mode = "ok";
  view.phases.set("w3", "error");
  await labels.pass();
  assert.ok(fake.workspaces.w3!.pinnedAt);
  assert.equal(labels.status().pins, 1);
  view.phases.clear();
  await labels.pass();
  labels.configure({ labels: false, pin: false });
  await labels.pass();
  assert.equal(fake.workspaces.w1!.pinnedAt, userPin, "after a failed pin, the user's pin stays");
  assert.equal(fake.workspaces.w2!.pinnedAt, userRepin, "after a lost answer, the user's pin stays");
  assert.equal(fake.workspaces.w3!.pinnedAt, null, "the confirmed one was the plugin's and is undone");
  assert.deepEqual(labels.status(), { state: "off", labels: 0, pins: 0, error: null });
  await labels.close();
});

test("a pin whose answer was lost is not claimed: it may stay after the reason clears and after turning it off (the user unpins it)", async () => {
  const fake = fakeHost({ w1: { labels: [] } });
  fake.host.pin = async (workspaceId, pinned) => {
    fake.workspaces[workspaceId]!.pinnedAt = pinned ? new Date().toISOString() : null;
    if (pinned) throw Object.assign(new Error("Paseo did not respond"), { code: "timeout" });
    return null;
  };
  const { labels, view } = await sync(fake.host, { w1: "approval" });
  labels.configure({ labels: true, pin: true });
  await labels.pass();
  assert.equal(labels.status().error, "Paseo 没有回应，这次写入可能已经生效");
  view.phases.delete("w1");
  await labels.pass();
  labels.configure({ labels: false, pin: false });
  await labels.pass();
  assert.ok(fake.workspaces.w1!.pinnedAt, "never guessed to be the plugin's: left for the user");
  assert.deepEqual(fake.workspaces.w1!.labels, [], "its label (owned before the write) still comes off");
  await labels.close();
});
