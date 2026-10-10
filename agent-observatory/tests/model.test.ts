import assert from "node:assert/strict";
import test from "node:test";
import { needsAttention } from "../shared/dashboard-model";
import { applyArchiveReadOrigin, applyReadReceipt, applyTelemetry, buildAgentForest, classifyAgentStatus, completionReadState, filterAgentForest, flattenAgentForest, formatDuration, formatRelativeTime, formatTokens, isUnreadCompletion, knownCompletionAt, normalizeAgent, preserveCompletionEvidence } from "../shared/model";

const time = "2026-09-16T12:00:00.000Z";
const later = "2026-09-16T12:05:00.000Z";

test("idle is distinct from observed completion, and live work overrides old outcomes", () => {
  assert.equal(classifyAgentStatus({ status: "idle" }), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished" }), "completed");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished", attentionTimestamp: time, lastUserMessageAt: later }), "quiet");
  const outcome = { outcome: "completed" as const, turnEndedAt: time };
  assert.equal(classifyAgentStatus({ status: "running", attentionReason: "finished" }, outcome), "running");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: later }, outcome), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle" }, outcome), "completed");
  assert.equal(classifyAgentStatus({ status: "idle" }, { outcome: "canceled", turnEndedAt: time }), "canceled");
  assert.equal(classifyAgentStatus({ status: "idle" }, { outcome: "failed", turnEndedAt: time }), "error");
});

test("待回复 needs a final reply that asks the user, newer than their latest message", () => {
  const asked = { outcome: "completed" as const, turnStartedAt: "2026-09-16T11:50:00Z", turnEndedAt: time, replyAt: time, replyAsks: true };
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z" }, asked), "idle");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: later }, asked), "quiet", "answered: a newer message retires the question");
  assert.equal(classifyAgentStatus({ status: "running", lastUserMessageAt: later }, asked), "running");
  assert.equal(classifyAgentStatus({ status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z" }, { ...asked, replyAsks: false }), "completed");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "finished", attentionTimestamp: later, requiresAttention: true }, { ...asked, turnEndedAt: null, outcome: null }), "idle", "native completion plus a question");
  assert.equal(classifyAgentStatus({ status: "idle", pendingPermissionCount: 1 }, asked), "waiting");
});

test("a question stays 待回复 through read state: unread it needs attention, read it only waits", () => {
  const lifecycle = { outcome: "completed" as const, turnStartedAt: "2026-09-16T11:50:00Z", turnEndedAt: time, replyAt: time, replyAsks: true };
  const unread = applyTelemetry(normalizeAgent({ id: "q", status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z", requiresAttention: true, attentionReason: "finished", attentionTimestamp: time }), lifecycle);
  assert.equal(unread.status, "idle"); assert.equal(unread.completionAt, null); assert.equal(isUnreadCompletion(unread), false); assert.equal(needsAttention(unread), true);
  const read = applyTelemetry(normalizeAgent({ id: "q", status: "idle", lastUserMessageAt: "2026-09-16T11:49:00Z", requiresAttention: false }), lifecycle);
  assert.equal(read.status, "idle"); assert.equal(needsAttention(read), false);
  assert.equal(applyReadReceipt(read, { agentId: "q", completionAt: time, lastUserMessageAt: "2026-09-16T11:49:00Z", readAt: later }).status, "idle", "a receipt cannot turn a question into a result");
  assert.equal(preserveCompletionEvidence(normalizeAgent({ id: "q", status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: time }), read).status, "idle");
});

test("permissions win, but old error text and dismissed attention do not invent current errors", () => {
  assert.equal(classifyAgentStatus({ status: "running", pendingPermissions: [{}] }), "waiting");
  assert.equal(classifyAgentStatus({ status: "idle", pendingPermissionCount: 2 }), "waiting");
  assert.equal(classifyAgentStatus({ status: "idle", attentionReason: "permission", requiresAttention: false }), "quiet");
  assert.equal(classifyAgentStatus({ status: "idle", lastError: "A previous run failed" }), "quiet");
  assert.equal(classifyAgentStatus({ status: "initializing" }), "initializing");
  assert.equal(classifyAgentStatus({ status: "closed" }), "closed");
});

test("normalization preserves missing metrics and parent labels without inventing token totals", () => {
  const agent = normalizeAgent({ id: "child", status: "idle", cwd: "/repo/project", labels: { "paseo.parent-agent-id": " parent " }, createdAt: "invalid", updatedAt: time, lastUsage: { inputTokens: 200, cachedInputTokens: 100, totalCostUsd: 0, contextWindowMaxTokens: Infinity } });
  assert.equal(agent.parentAgentId, "parent");
  assert.equal(agent.workspaceName, "project");
  assert.equal(agent.createdAt, null);
  assert.equal(agent.lastActivityAt, time);
  assert.equal(agent.usage.totalTokens, null);
  assert.equal(agent.usage.outputTokens, null);
  assert.equal(agent.usage.costUsd, 0);
  assert.equal(agent.usage.contextTotal, null);
  const counted = normalizeAgent({ id: "x", lastUsage: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 } });
  assert.equal(counted.usage.totalTokens, 250, "cached input must not be counted twice");
});

test("renamed project identity remains distinct from a workspace title and worktree slug", () => {
  const agent = normalizeAgent({ id: "a", status: "running", workspaceName: "Payment hotfix", cwd: "/home/user/.paseo/worktrees/abc/bright-river" }, {
    project: { projectKey: "project-123", projectName: "Commerce Platform", workspaceName: "Checkout v2", checkout: { cwd: "/home/user/.paseo/worktrees/abc/bright-river", worktreeRoot: "/home/user/.paseo/worktrees/abc/bright-river", mainRepoRoot: "/repos/commerce-platform" } },
  });
  assert.equal(agent.projectId, "project-123");
  assert.equal(agent.projectName, "Commerce Platform");
  assert.equal(agent.workspaceName, "Checkout v2");
  assert.equal(agent.projectRootPath, "/repos/commerce-platform");
  assert.equal(agent.cwd, "/home/user/.paseo/worktrees/abc/bright-river");
});

test("missing project metadata uses directory identity and never a workspace's custom title", () => {
  const agent = normalizeAgent({ id: "a", cwd: "/repos/commerce-platform", workspaceName: "My release workspace" });
  assert.equal(agent.projectName, "commerce-platform");
  assert.equal(agent.projectId, null);
  assert.equal(agent.projectRootPath, "/repos/commerce-platform");
  assert.equal(normalizeAgent({ id: "b", workspaceName: "Misleading title" }).projectName, "未关联项目");
  assert.equal(normalizeAgent({ id: "c", cwd: "/home/user/.paseo/worktrees/abc/bright-river", workspaceName: "My worktree" }).projectName, "未关联项目");
  assert.equal(normalizeAgent({ id: "d", projectName: "Renamed project", projectId: "p4", projectRootPath: "/repo/legacy-name", cwd: "/checkout/task" }).projectName, "Renamed project");
});

test("worktree labels come from actual checkout roots, separate from project and workspace titles", () => {
  const agent = normalizeAgent({ id: "task", cwd: "/worktrees/payments-v2/src", workspaceName: "User's review workspace" }, {
    project: { projectKey: "commerce", projectName: "Commerce Platform", workspaceName: "Checkout v2", checkout: {
      cwd: "/worktrees/payments-v2/src", isGit: true, currentBranch: "feature/payments-v2", isPaseoOwnedWorktree: true,
      mainRepoRoot: "/repos/commerce", worktreeRoot: "/worktrees/payments-v2",
    } },
  });
  assert.equal(agent.checkoutKind, "worktree");
  assert.equal(agent.worktreeName, "payments-v2");
  assert.equal(agent.worktreePath, "/worktrees/payments-v2");
  assert.equal(agent.branch, "feature/payments-v2");
  assert.equal(agent.workspaceName, "Checkout v2");
  assert.equal(agent.projectName, "Commerce Platform");
  assert.equal(agent.projectRootPath, "/repos/commerce");
  const external = normalizeAgent({ id: "external", cwd: "/trees/fix" }, { project: { checkout: {
    isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: "/repos/main", worktreeRoot: "/trees/fix", currentBranch: "fix/edge",
  } } });
  assert.equal(external.checkoutKind, "worktree", "external worktrees have real separated roots too");
  assert.equal(external.worktreeName, "fix");
});

test("main Git roots, local directories and missing metadata never invent worktree names", () => {
  const main = normalizeAgent({ id: "main", cwd: "/repos/main/src" }, { project: { checkout: {
    cwd: "/repos/main/src", isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: "/repos/main/", worktreeRoot: "/repos/main", currentBranch: "main",
  } } });
  assert.equal(main.checkoutKind, "main");
  assert.equal(main.worktreeName, null);
  assert.equal(main.worktreePath, null);
  assert.equal(main.branch, "main");
  const subdirectory = normalizeAgent({ id: "sub", cwd: "/repos/main/src" }, { project: { checkout: { isGit: true, mainRepoRoot: "/repos/main", cwd: "/repos/main/src" } } });
  assert.equal(subdirectory.checkoutKind, "main", "cwd under a repository does not prove another worktree");
  const directory = normalizeAgent({ id: "local", cwd: "/notes", checkoutKind: "worktree", worktreePath: "/old/tree", branch: "old" }, { project: { checkout: { isGit: false, currentBranch: null, worktreeRoot: null, mainRepoRoot: null } } });
  assert.equal(directory.checkoutKind, "directory");
  assert.equal(directory.worktreeName, null);
  assert.equal(directory.worktreePath, null);
  assert.equal(directory.branch, null);
  const unknown = normalizeAgent({ id: "unknown", cwd: "/repos/project", workspaceName: "My worktree" });
  assert.equal(unknown.checkoutKind, "unknown");
  assert.equal(unknown.worktreeName, null);
});

test("branch null means detached or unreported, while partial metadata preserves known branch", () => {
  const initial = { id: "task", cwd: "/trees/review", checkoutKind: "worktree" as const, worktreePath: "/trees/review", branch: "review" };
  const detached = normalizeAgent(initial, { project: { checkout: { currentBranch: null } } });
  assert.equal(detached.branch, null);
  assert.equal(detached.worktreeName, "review");
  const renamed = normalizeAgent(initial, { project: { workspaceName: "Renamed workspace" } });
  assert.equal(renamed.branch, "review");
  assert.equal(renamed.worktreeName, "review");
  assert.equal(renamed.workspaceName, "Renamed workspace");
});

test("completion read state distinguishes native unread, read, unknown, stale and active states", () => {
  const source = { id: "done", status: "idle", lastUserMessageAt: time, attentionReason: "finished", attentionTimestamp: later, requiresAttention: true };
  const unread = normalizeAgent(source);
  assert.equal(completionReadState(unread), "unread");
  assert.equal(isUnreadCompletion(unread), true);
  assert.equal(knownCompletionAt(unread), later);
  assert.equal(completionReadState(normalizeAgent({ ...source, requiresAttention: false })), "read");
  assert.equal(completionReadState(normalizeAgent({ ...source, requiresAttention: undefined })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, attentionTimestamp: undefined, status: "completed" })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "completed", lastUserMessageAt: "2026-09-16T12:06:00Z" })), "unknown");
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "running" })), "not_completed");
  assert.equal(completionReadState(normalizeAgent({ ...source, pendingPermissionCount: 1 })), "not_completed");
  assert.equal(isUnreadCompletion(normalizeAgent({ ...source, status: "closed", archivedAt: "2026-09-16T12:06:00Z" })), false);
  assert.equal(completionReadState(normalizeAgent({ ...source, status: "closed", archivedAt: "2026-09-16T12:06:00Z", requiresAttention: false })), "unknown", "native archive clears attention without marking the result read");
  assert.equal(completionReadState({ ...unread, pendingPermissionCount: 1, requiresAttention: false }), "unknown");
});

test("native completion tokens remain authoritative over later hook observation times and read receipts", () => {
  const nativeAt = "2026-09-17T04:03:36.882Z";
  const hookAt = "2026-09-17T04:03:36.887Z";
  const prompt = "2026-09-17T04:00:00Z";
  const outcome = { outcome: "completed" as const, turnStartedAt: prompt, turnEndedAt: hookAt };
  const source = { id: "timing", status: "idle", lastUserMessageAt: prompt, requiresAttention: true, attentionReason: "finished", attentionTimestamp: nativeAt };
  const withHook = applyTelemetry(normalizeAgent(source), outcome);
  assert.equal(withHook.completionAt, nativeAt);
  assert.equal(knownCompletionAt(withHook), nativeAt);
  assert.equal(completionReadState(withHook), "unread");
  assert.equal(normalizeAgent(source, { lifecycle: outcome }).completionAt, nativeAt);
  const cleared = normalizeAgent({ ...source, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const retained = applyTelemetry(preserveCompletionEvidence(withHook, cleared), outcome);
  assert.equal(retained.completionAt, nativeAt);
  assert.equal(completionReadState(retained), "read");
  const receipt = { completionAt: nativeAt, lastUserMessageAt: prompt, readAt: "2026-09-17T04:03:37Z" };
  const reloaded = applyReadReceipt(applyTelemetry(cleared, outcome), receipt);
  assert.equal(reloaded.completionAt, nativeAt, "an explicit receipt refines the observed hook time back to the exact native token");
  assert.equal(reloaded.completionReadFor, nativeAt);
  assert.equal(completionReadState(reloaded), "read");
});

test("archived completed results become read only with a matching explicit acknowledgement", () => {
  const archived = normalizeAgent({ id: "archived", status: "closed", lastUserMessageAt: time, attentionReason: "finished", attentionTimestamp: later, requiresAttention: false, archivedAt: "2026-09-16T12:07:00Z" });
  assert.equal(completionReadState(archived), "unknown");
  const read = applyReadReceipt(archived, { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:06:00Z" });
  assert.equal(completionReadState(read), "read");
  assert.equal(isUnreadCompletion(read), false);
});

test("archive-origin attention clearing remains unknown after restore and across origin reload", () => {
  const source = { id: "restore", status: "idle", lastUserMessageAt: time, updatedAt: later, attentionReason: "finished", attentionTimestamp: later, requiresAttention: true };
  const unread = normalizeAgent(source);
  const archivedAt = "2026-09-16T12:06:00Z";
  const archived = preserveCompletionEvidence(unread, normalizeAgent({ ...source, status: "closed", archivedAt, updatedAt: archivedAt, attentionReason: null, attentionTimestamp: null, requiresAttention: false }));
  const restoredSource = { ...source, updatedAt: "2026-09-16T12:07:00Z", attentionReason: null, attentionTimestamp: null, requiresAttention: false };
  const restored = preserveCompletionEvidence(archived, normalizeAgent(restoredSource));
  assert.equal(restored.status, "completed"); assert.equal(restored.archiveReadOriginAt, archivedAt);
  assert.equal(completionReadState(restored), "unknown", "unarchiving does not prove the result was viewed");
  const reloaded = applyArchiveReadOrigin(normalizeAgent(restoredSource, { lifecycle: { outcome: "completed", turnEndedAt: later } }), { agentId: "restore", archivedAt, lastUserMessageAt: time });
  assert.equal(completionReadState(reloaded), "unknown");
  const read = applyReadReceipt(reloaded, { agentId: "restore", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:30Z" });
  assert.equal(completionReadState(read), "read");
  const newCompletion = applyArchiveReadOrigin(normalizeAgent({ ...source, lastUserMessageAt: "2026-09-16T12:08:00Z", attentionTimestamp: "2026-09-16T12:09:00Z" }), { agentId: "restore", archivedAt, lastUserMessageAt: time });
  assert.equal(newCompletion.archiveReadOriginAt, null); assert.equal(isUnreadCompletion(newCompletion), true);
});

test("explicit receipts restore cleared completion without fabricating native attention fields", () => {
  const cleared = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const receipt = { agentId: "done", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  assert.equal(cleared.status, "quiet", "without prior observation or receipt a native clear does not prove completion");
  const restored = applyReadReceipt(cleared, receipt);
  assert.equal(restored.status, "completed");
  assert.equal(restored.completionAt, later);
  assert.equal(restored.lastExecutionAt, later);
  assert.equal(completionReadState(restored), "read");
  assert.equal(restored.requiresAttention, false);
  assert.equal(restored.attentionReason, null);
  assert.equal(restored.attentionTimestamp, null);
  const unknown = applyReadReceipt({ ...cleared, requiresAttention: undefined }, receipt);
  assert.equal(completionReadState(unknown), "read", "an explicit successful receipt provides read evidence even if native flag is omitted");
});

test("matching receipts suppress only the exact acknowledged native completion token", () => {
  const unread = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: true, attentionReason: "finished", attentionTimestamp: later });
  const receipt = { agentId: "done", completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  const read = applyReadReceipt(unread, receipt);
  assert.equal(completionReadState(read), "read");
  assert.equal(read.requiresAttention, true, "receipt hints must not overwrite the native snapshot");
  const newer = { ...read, attentionTimestamp: "2026-09-16T12:06:00Z" };
  assert.equal(completionReadState(newer), "unread");
  assert.equal(applyReadReceipt(newer, receipt), newer, "newer native completion always wins");
  const wrongAgent = { ...receipt, agentId: "different" };
  assert.equal(applyReadReceipt(unread, wrongAgent), unread);
});

test("old receipts cannot override new prompts, starts, errors or permissions", () => {
  const receipt = { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" };
  for (const source of [
    { status: "idle", lastUserMessageAt: "2026-09-16T12:06:00Z" },
    { status: "running", lastUserMessageAt: time },
    { status: "idle", lastUserMessageAt: time, activeTurn: { startedAt: "2026-09-16T12:06:00Z" } },
    { status: "error", lastUserMessageAt: time },
    { status: "idle", lastUserMessageAt: time, pendingPermissionCount: 1 },
    { status: "closed", lastUserMessageAt: time, attentionReason: "error", attentionTimestamp: "2026-09-16T12:06:00Z" },
  ]) {
    const agent = normalizeAgent({ id: "done", ...source });
    assert.equal(applyReadReceipt(agent, receipt), agent);
  }
  const agent = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time });
  assert.equal(applyReadReceipt(agent, { ...receipt, readAt: time }), agent, "receipt cannot predate completion");
});

test("native acknowledgement retains observed completion but fresh plugin state stays honest", () => {
  const previous = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: true, attentionReason: "finished", attentionTimestamp: later });
  const cleared = normalizeAgent({ id: "done", status: "idle", lastUserMessageAt: time, requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  const retained = preserveCompletionEvidence(previous, cleared);
  assert.equal(retained.status, "completed");
  assert.equal(retained.completionAt, later);
  assert.equal(retained.lastExecutionAt, later);
  assert.equal(completionReadState(retained), "read");
  assert.equal(preserveCompletionEvidence(undefined, cleared).status, "quiet");
  assert.equal(applyTelemetry(retained, { outcome: "failed", turnStartedAt: time, turnEndedAt: "2026-09-16T12:01:00Z" }).status, "completed", "older lifecycle failure cannot erase newer proven completion");
  const starting = applyTelemetry(retained, { outcome: null, turnStartedAt: "2026-09-16T12:06:00Z", turnEndedAt: null });
  assert.equal(starting.status, "quiet", "a newer observed start invalidates old completion before the native running snapshot arrives");
  assert.equal(applyReadReceipt(starting, { completionAt: later, lastUserMessageAt: time, readAt: "2026-09-16T12:05:01Z" }), starting);
});

test("telemetry enriches a matching terminal turn without overriding live work", () => {
  const lifecycle = { outcome: "completed" as const, turnEndedAt: time, turnStartedAt: "2026-09-16T11:50:00Z" };
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "idle" }), lifecycle).status, "completed");
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "running" }), lifecycle).status, "running");
  assert.equal(applyTelemetry(normalizeAgent({ id: "a", status: "idle", lastUserMessageAt: later }), lifecycle).status, "quiet");
});
test("archived closed sessions keep proven completion independently of archival state", () => {
  const archived = "2026-09-17T00:00:00Z";
  const source = { id: "history", status: "closed", archivedAt: archived, updatedAt: archived,
    createdAt: "2026-09-01T00:00:00Z", lastUserMessageAt: "2026-09-16T11:00:00Z" };
  const known = normalizeAgent(source, { lifecycle: { outcome: "completed", turnEndedAt: time } });
  assert.equal(known.status, "completed"); assert.equal(known.rawStatus, "closed"); assert.equal(known.archivedAt, archived);
  assert.equal(known.lastActivityAt, time);
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "completed", turnEndedAt: time }).status, "completed");
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "failed", turnEndedAt: time }).status, "error");
  assert.equal(applyTelemetry(normalizeAgent(source), { outcome: "canceled", turnEndedAt: time }).status, "canceled");
  assert.equal(normalizeAgent(source).status, "closed", "closed without outcome is not completion");
});
test("closed snapshots accept current terminal evidence but reject newer prompt or start conflicts", () => {
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }), "completed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time, lastUserMessageAt: later }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", lastUserMessageAt: later }), "closed", "undated attention cannot disprove a newer prompt");
  assert.equal(classifyAgentStatus({ status: "closed", activeTurn: { startedAt: later } }, { outcome: "completed", turnEndedAt: time }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }, { outcome: "completed", turnEndedAt: time, turnStartedAt: later }), "closed");
  assert.equal(classifyAgentStatus({ status: "closed", attentionReason: "finished", attentionTimestamp: time }, { outcome: "failed", turnEndedAt: later }), "error", "newer terminal evidence takes precedence");
});
test("archival metadata does not overwrite historical execution activity", () => {
  const archivedAt = "2026-09-17T00:00:00Z";
  const agent = normalizeAgent({ id: "a", status: "closed", createdAt: "2026-08-01T00:00:00Z", lastUserMessageAt: time, updatedAt: archivedAt, archivedAt });
  assert.equal(agent.updatedAt, archivedAt); assert.equal(agent.lastActivityAt, time); assert.equal(agent.lastExecutionAt, time);
  const enriched = applyTelemetry(agent, { outcome: "completed", turnEndedAt: later });
  assert.equal(enriched.lastExecutionAt, later); assert.equal(enriched.lastActivityAt, later);
  const unknown = normalizeAgent({ id: "unknown", status: "closed", createdAt: time, archivedAt, updatedAt: archivedAt });
  assert.equal(unknown.lastActivityAt, time);
});

test("tree is cycle safe, deduplicated, and retains orphan agents", () => {
  const agents = [
    normalizeAgent({ id: "a", title: "A", parentAgentId: "b", status: "idle", updatedAt: time }),
    normalizeAgent({ id: "b", title: "B", parentAgentId: "c", status: "idle" }),
    normalizeAgent({ id: "c", title: "C", parentAgentId: "a", status: "idle" }),
    normalizeAgent({ id: "orphan", parentAgentId: "gone", status: "running" }),
    normalizeAgent({ id: "self", parentAgentId: "self", status: "idle" }),
    normalizeAgent({ id: "a", title: "Newest A", parentAgentId: "b", status: "idle", updatedAt: later }),
  ];
  const tree = buildAgentForest(agents);
  const flattened = flattenAgentForest(tree);
  assert.equal(flattened.length, 5);
  assert.equal(new Set(flattened.map(({ node }) => node.agent.id)).size, 5);
  assert.equal(flattened.find(({ node }) => node.agent.id === "a")?.node.agent.title, "Newest A");
  assert.equal(tree.find((node) => node.agent.id === "orphan")?.orphaned, true);
  assert.equal(flattened.filter(({ node }) => node.cycleBroken).length, 4);
  assert.ok(tree.some((node) => node.agent.id === "a"));
});

test("tree filtering keeps a matching child's ancestry without unrelated siblings", () => {
  const forest = buildAgentForest([
    normalizeAgent({ id: "root", title: "Build app", status: "idle" }),
    normalizeAgent({ id: "match", title: "Payment regression", parentAgentId: "root", status: "running" }),
    normalizeAgent({ id: "sibling", title: "Docs", parentAgentId: "root", status: "completed" }),
    normalizeAgent({ id: "unrelated", title: "Other work", status: "running" }),
  ]);
  assert.deepEqual(flattenAgentForest(filterAgentForest(forest, { query: "payment" })).map(({ node }) => node.agent.id), ["root", "match"]);
  assert.equal(flattenAgentForest(filterAgentForest(forest, { query: "Build app" })).length, 3, "matching parent retains child context");
  assert.equal(flattenAgentForest(filterAgentForest(forest, { query: "nothing" })).length, 0);
});

test("deep nested trees are iterative and safe for corrupt long parent chains", () => {
  const agents = Array.from({ length: 5_000 }, (_, index) => normalizeAgent({ id: `${index}`, parentAgentId: index ? `${index - 1}` : null, status: "idle", title: index === 4_999 ? "needle" : "node" }));
  const result = flattenAgentForest(filterAgentForest(buildAgentForest(agents), { query: "needle" }));
  assert.equal(result.length, 5_000);
  assert.equal(result.at(-1)?.depth, 4_999);
});

test("formatters handle unknown values, clock skew and units", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(-100), "0秒");
  assert.equal(formatDuration(61_000), "1分 1秒");
  assert.equal(formatRelativeTime("bad"), "—");
  assert.equal(formatRelativeTime(later, Date.parse(time)), "刚刚");
  assert.equal(formatRelativeTime(time, Date.parse(later)), "5分钟前");
  assert.equal(formatTokens(null), "—");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(1_250), "1.3k");
});
