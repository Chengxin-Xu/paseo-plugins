/** Pure dashboard models. This module is shared by native and web clients. */
/**
 * `idle` is 待回复: the latest final reply hands the next step to the user (a question, a choice, a request). `quiet` (空闲)
 * is a stopped Agent whose last turn left no known result: never observed ending and no final reply found.
 */
export const AGENT_STATUSES = ["running", "waiting", "idle", "completed", "quiet", "error", "initializing", "closed", "canceled"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type CheckoutKind = "worktree" | "main" | "directory" | "unknown";
export type CompletionReadState = "unread" | "read" | "unknown" | "not_completed";
export type CompletionReadFilter = "all" | "unread" | "read";

/** 后台执行中: provider subagents still working after the Agent's own turn ended (Paseo shows them as "N working"). */
export interface AgentBackground {
  running: number;
  /** Start of the earliest current run; null when it began before the plugin observed it. */
  since: string | null;
  updatedAt: string | null;
  /** What they work on, newest first. */
  labels: string[];
}

export interface AgentUsageRecord {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
}

export interface AgentRecord {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  projectId: string | null;
  projectName: string;
  projectRootPath: string | null;
  checkoutKind: CheckoutKind;
  worktreeName: string | null;
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null;
  parentAgentId: string | null;
  status: AgentStatus;
  rawStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  /** Execution evidence, excluding archive/rename metadata writes. */
  lastExecutionAt?: string | null;
  lastUserMessageAt: string | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  /** Proven completion time, retained separately when native read clears attention. */
  completionAt?: string | null;
  /** Explicit receipt hints; native attention fields remain unchanged. */
  completionReadAt?: string | null;
  completionReadFor?: string | null;
  /** Native false can come from archiving rather than reading a result. */
  archiveReadOriginAt?: string | null;
  archiveReadOriginUserAt?: string | null;
  activeTurnStartedAt: string | null;
  archivedAt: string | null;
  pendingPermissionCount: number;
  lastError: string | null;
  attentionReason: string | null;
  usage: AgentUsageRecord;
  labels: Record<string, string>;
  background?: AgentBackground | null;
}

/** Structural input allows snapshot normalization without a runtime SDK import. */
export interface AgentSource {
  id: string;
  title?: string | null;
  provider?: string;
  model?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectRootPath?: string | null;
  checkoutKind?: CheckoutKind;
  worktreeName?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  checkout?: AgentCheckoutMetadata | null;
  cwd?: string | null;
  parentAgentId?: string | null;
  status?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  activeTurn?: { startedAt?: string | null } | null;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[];
  pendingPermissionCount?: number;
  lastError?: string | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  labels?: Record<string, string>;
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalCostUsd?: number;
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
  } | null;
}

export interface LifecycleOutcome {
  outcome: "completed" | "failed" | "canceled" | null;
  turnEndedAt: string | null;
  turnStartedAt?: string | null;
  /** When the latest turn's final reply was written and whether it asks the user something (待回复). */
  replyAt?: string | null;
  replyAsks?: boolean | null;
}

export interface CompletionReadReceipt {
  agentId?: string;
  completionAt: string;
  lastUserMessageAt: string | null;
  readAt: string;
}

export interface ArchiveReadOrigin {
  agentId?: string;
  archivedAt: string;
  lastUserMessageAt: string | null;
}

/** Exact structural subset of Paseo 0.8 ProjectPlacementPayload. */
export interface AgentCheckoutMetadata {
  cwd?: string | null;
  isGit?: boolean;
  currentBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  worktreeRoot?: string | null;
}

export interface AgentProjectPlacement {
  projectKey?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  checkout?: AgentCheckoutMetadata | null;
}

export function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validDate(value: string | null | undefined): string | null {
  return timestamp(value) === null ? null : value!;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Compare metadata roots without confusing trailing separators with separation. */
function comparablePath(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

function normalizeCheckout(source: AgentSource, checkout?: AgentCheckoutMetadata | null): Pick<AgentRecord, "checkoutKind" | "worktreeName" | "worktreePath" | "branch"> {
  const root = text(checkout?.worktreeRoot);
  const main = text(checkout?.mainRepoRoot);
  const separated = root !== null && main !== null && comparablePath(root) !== comparablePath(main);
  const knownMain = checkout?.isGit === true || (root !== null && main !== null && !separated);
  const checkoutKind: CheckoutKind = checkout?.isGit === false ? "directory"
    : checkout?.isPaseoOwnedWorktree === true || separated ? "worktree"
    : knownMain ? "main" : source.checkoutKind ?? "unknown";
  const worktreePath = checkoutKind === "worktree" ? root ?? text(source.worktreePath) : null;
  const worktreeName = worktreePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const branch = checkoutKind === "directory" ? null : checkout?.currentBranch !== undefined ? text(checkout.currentBranch) : text(source.branch);
  return { checkoutKind, worktreeName, worktreePath, branch };
}

function latestDate(values: Array<string | null | undefined>): string | null {
  return values.map(validDate).filter((date): date is string => date !== null)
    .sort((a, b) => timestamp(b)! - timestamp(a)!)[0] ?? null;
}
function currentLifecycleOutcome(source: Omit<AgentSource, "id">, lifecycle?: LifecycleOutcome | null) {
  if (!lifecycle?.outcome) return null;
  const endedAt = timestamp(lifecycle.turnEndedAt);
  const latestStart = Math.max(timestamp(source.lastUserMessageAt) ?? 0, timestamp(source.activeTurn?.startedAt) ?? 0,
    timestamp(lifecycle.turnStartedAt) ?? 0, timestamp(source.createdAt) ?? 0);
  return endedAt !== null && endedAt >= latestStart ? { status: lifecycle.outcome === "failed" ? "error" as const : lifecycle.outcome, at: endedAt } : null;
}

function nativeCompletionTimestamp(agent: AgentRecord): string | null {
  const at = timestamp(agent.attentionTimestamp);
  const latestStart = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(agent.createdAt) ?? 0);
  return agent.attentionReason === "finished" && at !== null && at >= latestStart ? validDate(agent.attentionTimestamp) : null;
}

/** This never derives completion from a generic updatedAt or an assistant reply. */
/** The Agent's own turn is running (not waiting for approval, not only its background subagents). */
export function ownTurnRunning(agent: AgentRecord): boolean {
  return agent.status === "running" && agent.rawStatus === "running";
}

export function knownCompletionAt(agent: AgentRecord): string | null {
  if (agent.status !== "completed") return null;
  const latestStart = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(agent.createdAt) ?? 0);
  const hint = timestamp(agent.completionAt);
  // Native attention timestamps are the acknowledgement token. Hook collection
  // normally happens milliseconds later and must never replace that token.
  return nativeCompletionTimestamp(agent) ?? (hint !== null && hint >= latestStart ? validDate(agent.completionAt) : null);
}

export function completionReadState(agent: AgentRecord): CompletionReadState {
  if (agent.status !== "completed") return "not_completed";
  if (agent.pendingPermissionCount > 0 || agent.activeTurnStartedAt) return "unknown";
  const completion = timestamp(knownCompletionAt(agent));
  const nativeCompletion = timestamp(nativeCompletionTimestamp(agent));
  const receiptCompletion = timestamp(agent.completionReadFor);
  const receiptReadAt = timestamp(agent.completionReadAt);
  const receiptMatches = completion !== null && receiptCompletion === completion && receiptReadAt !== null && receiptReadAt >= completion;
  // The server only stores successful acknowledgements. An exact-token receipt
  // can therefore beat an older client snapshot of that same native unread flag.
  if (receiptMatches && (agent.requiresAttention !== true || nativeCompletion === receiptCompletion)) return "read";
  // Archiving also clears native attention; that alone does not prove viewing.
  if (!agent.archivedAt && !agent.archiveReadOriginAt && agent.requiresAttention === false) return "read";
  if (!agent.archivedAt && agent.requiresAttention === true && nativeCompletion !== null && (completion === null || nativeCompletion >= completion)) return "unread";
  return "unknown";
}

export function isUnreadCompletion(agent: AgentRecord): boolean {
  return !agent.archivedAt && completionReadState(agent) === "unread";
}

/** Preserve the cause of native attention clearing through restoration/reload. */
export function applyArchiveReadOrigin(agent: AgentRecord, origin?: ArchiveReadOrigin | null): AgentRecord {
  if (!origin || origin.agentId && origin.agentId !== agent.id) return agent;
  const archivedAt = timestamp(origin.archivedAt);
  if (archivedAt === null || (timestamp(agent.createdAt) ?? 0) > archivedAt) return agent;
  const user = timestamp(agent.lastUserMessageAt), oldUser = timestamp(origin.lastUserMessageAt);
  if (user !== null && (user > archivedAt || oldUser !== null && user > oldUser)) return agent;
  if ((timestamp(nativeCompletionTimestamp(agent)) ?? 0) > archivedAt) return agent;
  return { ...agent, archiveReadOriginAt: validDate(origin.archivedAt), archiveReadOriginUserAt: validDate(origin.lastUserMessageAt) };
}

/** Restore only an explicitly acknowledged completion, never native attention. */
export function applyReadReceipt(agent: AgentRecord, receipt?: CompletionReadReceipt | null): AgentRecord {
  if (!receipt || receipt.agentId && receipt.agentId !== agent.id) return agent;
  if (!["completed", "quiet", "closed"].includes(agent.status) || !["completed", "idle", "closed"].includes(agent.rawStatus)) return agent;
  if (agent.pendingPermissionCount > 0 || agent.activeTurnStartedAt || agent.attentionReason === "permission" || agent.attentionReason === "error") return agent;
  if (agent.requiresAttention === true && agent.attentionReason !== "finished") return agent;
  const completion = timestamp(receipt.completionAt), readAt = timestamp(receipt.readAt);
  if (completion === null || readAt === null || readAt < completion || (timestamp(agent.createdAt) ?? 0) > completion) return agent;
  const currentUser = timestamp(agent.lastUserMessageAt), receiptUser = timestamp(receipt.lastUserMessageAt);
  if (currentUser !== null && (receiptUser === null || currentUser > receiptUser || currentUser > completion)) return agent;
  if (receiptUser !== null && receiptUser > completion) return agent;
  if ((timestamp(agent.lastExecutionAt) ?? 0) > readAt) return agent;
  const currentCompletion = timestamp(knownCompletionAt(agent));
  const nativeCompletion = timestamp(nativeCompletionTimestamp(agent));
  // An observed hook end can lag its native completion token. A receipt may
  // refine that estimate if it was acknowledged after the observed end.
  if (currentCompletion !== null && currentCompletion > completion && (nativeCompletion !== null || currentCompletion > readAt)) return agent;
  if (nativeCompletion !== null && nativeCompletion > completion) return agent;
  if (agent.requiresAttention === true && nativeCompletion !== completion) return agent;
  const at = validDate(receipt.completionAt)!;
  const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, at]);
  return { ...agent, status: "completed", completionAt: at, completionReadAt: validDate(receipt.readAt), completionReadFor: at,
    lastExecutionAt: execution, lastActivityAt: agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]) };
}

/** Preserve observed completion when native read clears its attention metadata. */
export function preserveCompletionEvidence(previous: AgentRecord | undefined, current: AgentRecord): AgentRecord {
  const archivedAt = previous?.archiveReadOriginAt ?? previous?.archivedAt;
  if (previous && archivedAt) current = applyArchiveReadOrigin(current, { agentId: previous.id, archivedAt, lastUserMessageAt: previous.archiveReadOriginUserAt ?? previous.lastUserMessageAt });
  if (!previous || previous.id !== current.id || previous.status !== "completed") return current;
  if (!["quiet", "closed"].includes(current.status) || !["idle", "closed"].includes(current.rawStatus)) return current;
  if (timestamp(previous.lastUserMessageAt) !== timestamp(current.lastUserMessageAt)) return current;
  if (current.pendingPermissionCount > 0 || current.activeTurnStartedAt || current.attentionReason === "error" || current.attentionReason === "permission") return current;
  if (current.requiresAttention === true && current.attentionReason !== "finished") return current;
  if (current.lastError !== null && current.lastError !== previous.lastError) return current;
  const completionAt = knownCompletionAt(previous);
  const execution = latestDate([previous.lastExecutionAt, current.lastExecutionAt, completionAt]);
  return { ...current, status: "completed", completionAt, completionReadAt: previous.completionReadAt ?? null, completionReadFor: previous.completionReadFor ?? null,
    lastExecutionAt: execution, lastActivityAt: current.archivedAt ? execution ?? current.lastActivityAt : latestDate([current.lastActivityAt, execution]) };
}

export function classifyAgentStatus(source: Omit<AgentSource, "id">, lifecycle?: LifecycleOutcome): AgentStatus {
  const pending = source.pendingPermissions?.length ?? source.pendingPermissionCount ?? 0;
  const attentionAt = timestamp(source.attentionTimestamp);
  const latestPromptAt = Math.max(timestamp(source.lastUserMessageAt) ?? 0, timestamp(source.activeTurn?.startedAt) ?? 0,
    timestamp(lifecycle?.turnStartedAt) ?? 0);
  const attentionIsCurrent = attentionAt === null ? latestPromptAt === 0 : attentionAt >= latestPromptAt;
  if (pending > 0 || (source.attentionReason === "permission" && source.requiresAttention !== false && attentionIsCurrent)) return "waiting";
  if (source.status === "running") return "running";
  if (source.status === "initializing") return "initializing";
  if (source.status === "error") return "error";
  if (source.status === "canceled" || source.status === "cancelled") return "canceled";
  // A completed turn whose final reply asks the user is 待回复 until they send the next message.
  const asks = lifecycle?.replyAsks === true && (timestamp(lifecycle.replyAt) ?? -1) >= latestPromptAt;
  const settled = (status: AgentStatus): AgentStatus => status === "completed" && asks ? "idle" : status;
  if (source.status === "completed") return settled("completed");
  const lifecycleResult = currentLifecycleOutcome(source, lifecycle);
  const attentionResult = attentionIsCurrent && source.attentionReason === "finished" ? "completed"
    : attentionIsCurrent && source.attentionReason === "error" && (source.requiresAttention !== false || source.archivedAt || source.status === "closed") ? "error" : null;
  // A closed runtime can still have a proven terminal result. Archive state is
  // tracked separately; it must not hide that result from completed searches.
  if (lifecycleResult && (!attentionResult || attentionAt === null || lifecycleResult.at >= attentionAt)) return settled(lifecycleResult.status);
  if (attentionResult) return settled(attentionResult);
  if (source.status === "closed") return "closed";
  return source.status === "idle" ? asks ? "idle" : "quiet" : "initializing";
}

export function normalizeAgent(source: AgentSource, options: { workspaceName?: string | null; lifecycle?: LifecycleOutcome; project?: AgentProjectPlacement | null } = {}): AgentRecord {
  const usage = source.lastUsage;
  const inputTokens = nonnegative(usage?.inputTokens);
  const outputTokens = nonnegative(usage?.outputTokens);
  const labels = Object.fromEntries(Object.entries(source.labels ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const currentOutcome = currentLifecycleOutcome(source, options.lifecycle);
  const status = classifyAgentStatus(source, options.lifecycle);
  const completionAt = status === "completed" ? validDate(source.attentionReason === "finished" ? source.attentionTimestamp : null)
    ?? validDate(currentOutcome?.status === "completed" ? options.lifecycle?.turnEndedAt : null) : null;
  const execution = latestDate([source.lastUserMessageAt, source.activeTurn?.startedAt, source.attentionTimestamp,
    currentOutcome ? options.lifecycle?.turnEndedAt : null]);
  const archivedAt = validDate(source.archivedAt);
  // Paseo's archive operation writes updatedAt=archivedAt and may clear attention.
  // Retained execution evidence is therefore more reliable for archived history.
  const beforeArchiveUpdate = archivedAt && timestamp(source.updatedAt) !== null && timestamp(source.updatedAt)! < timestamp(archivedAt)!
    ? validDate(source.updatedAt) : null;
  const activity = archivedAt ? execution ?? beforeArchiveUpdate ?? validDate(source.createdAt)
    : latestDate([source.updatedAt, execution, source.createdAt]);
  const cwd = text(source.cwd);
  const parent = text(source.parentAgentId) ?? text(labels["paseo.parent-agent-id"]);
  const checkout = options.project?.checkout ?? source.checkout;
  const checkoutFields = normalizeCheckout(source, checkout);
  // Prefer the original repository root over a worktree's generated directory.
  // A managed worktree without placement metadata cannot identify its project.
  const managedWorktree = cwd !== null && /[\\/]\.paseo[\\/]worktrees[\\/]/.test(cwd);
  const placementRoot = text(checkout?.mainRepoRoot) ?? (managedWorktree ? null : text(checkout?.worktreeRoot) ?? text(checkout?.cwd));
  const projectRootPath = placementRoot ?? text(source.projectRootPath) ?? (managedWorktree ? null : cwd);
  const projectName = text(options.project?.projectName) ?? text(source.projectName) ?? projectRootPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "未关联项目";
  return {
    id: source.id,
    title: text(source.title) ?? "未命名 Agent",
    provider: text(source.provider) ?? "unknown",
    model: text(source.model),
    workspaceId: text(source.workspaceId),
    workspaceName: text(options.workspaceName) ?? text(options.project?.workspaceName) ?? text(source.workspaceName) ?? (cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? null),
    projectId: text(options.project?.projectKey) ?? text(source.projectId),
    projectName,
    projectRootPath,
    ...checkoutFields,
    cwd,
    parentAgentId: parent,
    status,
    rawStatus: source.status ?? "unknown",
    createdAt: validDate(source.createdAt),
    updatedAt: validDate(source.updatedAt),
    lastActivityAt: activity,
    lastExecutionAt: execution,
    lastUserMessageAt: validDate(source.lastUserMessageAt),
    attentionTimestamp: validDate(source.attentionTimestamp),
    requiresAttention: source.requiresAttention,
    completionAt,
    completionReadAt: null,
    completionReadFor: null,
    archiveReadOriginAt: archivedAt,
    archiveReadOriginUserAt: archivedAt ? validDate(source.lastUserMessageAt) : null,
    activeTurnStartedAt: validDate(source.activeTurn?.startedAt),
    archivedAt,
    pendingPermissionCount: source.pendingPermissions?.length ?? Math.floor(nonnegative(source.pendingPermissionCount) ?? 0),
    lastError: text(source.lastError),
    attentionReason: text(source.attentionReason),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: nonnegative(usage?.cachedInputTokens),
      totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      costUsd: nonnegative(usage?.totalCostUsd),
      contextUsed: nonnegative(usage?.contextWindowUsedTokens),
      contextTotal: nonnegative(usage?.contextWindowMaxTokens),
    },
    labels,
  };
}

/** Known outcomes enrich idle/closed history; current live work always takes precedence. */
export function applyTelemetry(agent: AgentRecord, lifecycle?: LifecycleOutcome | null): AgentRecord {
  if (!lifecycle || ["running", "waiting", "initializing"].includes(agent.status)) return agent;
  const source = {
    status: agent.rawStatus,
    pendingPermissionCount: agent.pendingPermissionCount,
    createdAt: agent.createdAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    activeTurn: agent.activeTurnStartedAt ? { startedAt: agent.activeTurnStartedAt } : null,
    attentionReason: agent.attentionReason,
    attentionTimestamp: agent.attentionTimestamp,
    requiresAttention: agent.requiresAttention,
    archivedAt: agent.archivedAt,
  };
  const status = classifyAgentStatus(source, lifecycle);
  const outcome = currentLifecycleOutcome(source, lifecycle);
  if (status === "idle") {
    // 待回复 wins over any completion evidence: the turn is over, but the Agent is waiting for the user's answer.
    const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, lifecycle.turnStartedAt, lifecycle.replyAt, outcome ? lifecycle.turnEndedAt : null]);
    return { ...agent, status, completionAt: null, lastExecutionAt: execution, lastActivityAt: agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]) };
  }
  const existingCompletion = timestamp(knownCompletionAt(agent));
  if (existingCompletion !== null && outcome && outcome.at < existingCompletion) return agent;
  const sameKnownTurn = existingCompletion !== null && (timestamp(lifecycle.turnStartedAt) ?? 0) <= existingCompletion;
  const completionAt = status === "completed" ? nativeCompletionTimestamp(agent)
    ?? (sameKnownTurn ? knownCompletionAt(agent) : null)
    ?? validDate(outcome?.status === "completed" ? lifecycle.turnEndedAt : null) : null;
  const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, agent.activeTurnStartedAt,
    agent.attentionTimestamp, lifecycle.turnStartedAt, outcome ? lifecycle.turnEndedAt : null]);
  const activity = agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]);
  const result = status === agent.status && execution === agent.lastExecutionAt && activity === agent.lastActivityAt && completionAt === agent.completionAt ? agent
    : { ...agent, status, completionAt, lastExecutionAt: execution, lastActivityAt: activity };
  if (existingCompletion !== null && (timestamp(lifecycle.turnStartedAt) ?? 0) > existingCompletion) return result;
  return preserveCompletionEvidence(agent, result);
}

export interface AgentTreeNode {
  agent: AgentRecord;
  children: AgentTreeNode[];
  orphaned: boolean;
  cycleBroken: boolean;
}

const STATUS_ORDER: Record<AgentStatus, number> = { waiting: 0, error: 1, running: 3, initializing: 4, idle: 5, completed: 6, quiet: 7, canceled: 8, closed: 9 };
export function agentAttentionPriority(agent: AgentRecord): number {
  return isUnreadCompletion(agent) ? 2 : STATUS_ORDER[agent.status];
}
export function compareAgents(a: AgentRecord, b: AgentRecord): number {
  return agentAttentionPriority(a) - agentAttentionPriority(b) || (timestamp(b.lastActivityAt) ?? 0) - (timestamp(a.lastActivityAt) ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/** Each ID appears once. Missing parents become roots; corrupt cycles are broken deterministically. */
export function buildAgentForest(agents: readonly AgentRecord[]): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of agents) {
    const previous = nodes.get(agent.id);
    if (!previous || (timestamp(agent.updatedAt) ?? 0) >= (timestamp(previous.agent.updatedAt) ?? 0)) {
      nodes.set(agent.id, { agent, children: [], orphaned: false, cycleBroken: false });
    }
  }
  const parents = new Map<string, string | null>();
  for (const [id, node] of nodes) {
    const parent = node.agent.parentAgentId;
    node.orphaned = !!parent && !nodes.has(parent);
    parents.set(id, parent && nodes.has(parent) ? parent : null);
  }
  const visited = new Set<string>();
  for (const id of [...nodes.keys()].sort()) {
    if (visited.has(id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | null = id;
    while (cursor && !visited.has(cursor)) {
      const index = positions.get(cursor);
      if (index !== undefined) {
        const cycle = path.slice(index);
        const root = cycle.slice().sort()[0]!;
        parents.set(root, null);
        for (const member of cycle) nodes.get(member)!.cycleBroken = true;
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const member of path) visited.add(member);
  }
  const roots: AgentTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parent = parents.get(id);
    if (parent) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  roots.sort((a, b) => compareAgents(a.agent, b.agent));
  for (const node of nodes.values()) node.children.sort((a, b) => compareAgents(a.agent, b.agent));
  return roots;
}

export interface AgentFilter {
  query?: string;
  statuses?: readonly AgentStatus[];
  workspaceId?: string | null;
  provider?: string | null;
  readFilter?: CompletionReadFilter;
}

/** 执行中 includes sessions still starting, as its list section does. */
export function matchesStatus(status: AgentStatus, filter: AgentStatus | "all"): boolean {
  return filter === "all" || status === filter || (filter === "running" && status === "initializing");
}

export function matchesAgent(agent: AgentRecord, filter: AgentFilter): boolean {
  if (filter.statuses?.length && !filter.statuses.some(status => matchesStatus(agent.status, status))) return false;
  if (filter.workspaceId && agent.workspaceId !== filter.workspaceId) return false;
  if (filter.provider && agent.provider !== filter.provider) return false;
  if (filter.readFilter === "unread" && !isUnreadCompletion(agent)) return false;
  if (filter.readFilter === "read" && completionReadState(agent) !== "read") return false;
  const query = filter.query?.trim().toLocaleLowerCase();
  if (!query) return true;
  const haystack = [agent.id, agent.title, agent.provider, agent.model, agent.projectId, agent.projectName, agent.projectRootPath, agent.workspaceName, agent.worktreeName, agent.worktreePath, agent.branch, agent.cwd, ...Object.values(agent.labels)].filter(Boolean).join(" ").toLocaleLowerCase();
  return query.split(/\s+/).every((part) => haystack.includes(part));
}

/** Keep ancestors of matches, as well as descendants of matching parents, for tree context. */
export function filterAgentForest(forest: readonly AgentTreeNode[], filter: AgentFilter): AgentTreeNode[] {
  const retained = new Map<AgentTreeNode, AgentTreeNode>();
  const stack: { node: AgentTreeNode; parentMatched: boolean; exit: boolean }[] = forest.map((node) => ({ node, parentMatched: false, exit: false })).reverse();
  while (stack.length) {
    const frame = stack.pop()!;
    const direct = matchesAgent(frame.node.agent, filter);
    if (!frame.exit) {
      stack.push({ ...frame, exit: true });
      for (let i = frame.node.children.length - 1; i >= 0; i--) stack.push({ node: frame.node.children[i]!, parentMatched: frame.parentMatched || direct, exit: false });
    } else {
      const children = frame.node.children.map((child) => retained.get(child)).filter((child): child is AgentTreeNode => !!child);
      if (direct || frame.parentMatched || children.length) retained.set(frame.node, { ...frame.node, children });
    }
  }
  return forest.map((node) => retained.get(node)).filter((node): node is AgentTreeNode => !!node);
}

export function flattenAgentForest(forest: readonly AgentTreeNode[]): Array<{ node: AgentTreeNode; depth: number }> {
  const result: Array<{ node: AgentTreeNode; depth: number }> = [];
  const stack = forest.map((node) => ({ node, depth: 0 })).reverse();
  while (stack.length) {
    const entry = stack.pop()!;
    result.push(entry);
    for (let i = entry.node.children.length - 1; i >= 0; i--) stack.push({ node: entry.node.children[i]!, depth: entry.depth + 1 });
  }
  return result;
}

export function statusLabel(status: AgentStatus): string {
  return { running: "执行中", waiting: "待审批", idle: "待回复", completed: "已完成", quiet: "空闲", error: "异常", initializing: "启动中", closed: "已关闭", canceled: "已取消" }[status];
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分`;
  return `${Math.floor(seconds / 86400)}天 ${Math.floor(seconds % 86400 / 3600)}小时`;
}

export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  const at = timestamp(value);
  if (at === null || !Number.isFinite(now)) return "—";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时前`;
  return `${Math.floor(seconds / 86400)}天前`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.floor(value).toLocaleString();
}
