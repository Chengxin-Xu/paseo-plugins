import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { launchInputSchema, launchReceiptSchema, type LaunchAgent, type LaunchInput, type LaunchOptions, type LaunchReceipt, type LaunchRecord } from "../shared/launch";
import { INBOX_PROJECT_ID, type BoardItem } from "../shared/board";
import { ProjectDirectory, withTimeout, type PaseoProject } from "./dashboard";
import { BoardStore, defaultStorageRoot } from "./store";

type Paseo = PluginHandlerContext["paseo"];
type ListProjects = () => Promise<PaseoProject[]>;
const journalSchema = launchReceiptSchema.omit({ replayed: true }).extend({
  inputHash: z.string(), projectId: launchInputSchema.shape.projectId.optional(), isolation: launchInputSchema.shape.isolation.optional(),
  // Since 0.12: the note it started from and when, for the status on task cards. Older records lack them.
  itemId: launchInputSchema.shape.itemId.optional(), sourceProjectId: launchInputSchema.shape.sourceProjectId.optional(), createdAt: z.string().max(40).optional(),
});
type Journal = z.infer<typeof journalSchema>;
type Prepared = { project: LaunchOptions["projects"][number]; attachment: ReturnType<typeof sourceAttachment>; featureValues?: Record<string, unknown> };
const message = (e: unknown) => e instanceof Error ? e.message : t("serverLaunch.operationFailed");
/**
 * Provider and launch errors come from the daemon and the providers as they are. The dialog shows them in full and every
 * connected app can read them, so a stack trace or a dumped request stays bounded; 500 characters still fit any diagnosis.
 */
const MAX_ERROR_CHARS = 500;
function clip(text: string, max = MAX_ERROR_CHARS): string {
  const chars = Array.from(text); // code points: never split a surrogate pair
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}
/** Per-call timeouts that together stay inside the host's 30 s plugin RPC limit. */
function budget(totalMs: number) { const end = Date.now() + totalMs; return (maxMs: number) => Math.max(1, Math.min(maxMs, end - Date.now())); }

function absoluteDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error(t("serverLaunch.absolutePathRequired"));
  return value;
}

function sourceAttachment(note: BoardItem, projectName: string) {
  // The task is the user's edited prompt. Source metadata must not reintroduce deleted note content.
  const text = t("serverLaunch.sourceText", { id: note.id, project: projectName, title: note.title, status: { todo: t("serverLaunch.todo"), doing: t("serverLaunch.doing"), done: t("serverLaunch.done") }[note.status], priority: note.priority === "high" ? t("serverLaunch.yes") : t("serverLaunch.no") });
  return { type: "text" as const, mimeType: "text/plain" as const, contextKind: "project-notes", title: t("serverLaunch.sourceTitle", { id: note.id.slice(0, 8), title: note.title }), text };
}

const launchSuffix = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 12);
/** Launch records are a few hundred bytes; anything far larger is not one of ours and is skipped. */
const MAX_JOURNAL_BYTES = 64 * 1024;
/** The board-wide list carries at most this many records, newest first. */
const MAX_LISTED_RECORDS = 500;
const JOURNAL_FILE = /^[a-zA-Z0-9_-]{8,100}\.json$/;
const PENDING_STAGES = new Set<LaunchReceipt["stage"]>(["prepared", "creating_workspace", "workspace_ready", "creating_agent", "agent_ready", "sending"]);
/** The labels `start()` puts on the agent it creates. */
export const LAUNCH_LABEL = "project-notes.launch-id", ITEM_LABEL = "project-notes.item-id";
const terminal = (stage: LaunchReceipt["stage"]) => stage === "started" || stage === "rejected" || stage === "uncertain";

export async function loadLaunchOptions(paseo: Paseo, projectId?: string, listProjects: ListProjects = async () => (await paseo.projects.list()).projects): Promise<LaunchOptions> {
  const left = budget(24_000);
  const projects = (await listProjects()).map(p => ({ id: p.projectId, name: p.projectDisplayName, path: p.projectRootPath, kind: p.projectKind }));
  const project = projects.find(p => p.id === projectId) ?? null;
  if (!project) return { projects, project: null, providers: [], profiles: [] };
  absoluteDirectory(project.path);
  const timedOut = t("serverLaunch.optionsTimeout");
  const [initialCatalog, settings] = await Promise.all([
    withTimeout(paseo.providers.snapshot({ cwd: project.path }), left(9_000), timedOut),
    withTimeout(paseo.config.get(), left(6_000), timedOut),
  ]);
  let catalog = initialCatalog;
  if (!catalog.entries.some(p => p.enabled !== false && p.status === "ready")) {
    const waitMs = Math.max(1, left(8_000) - 500);
    catalog = await withTimeout(paseo.providers.waitForReady({ cwd: project.path, timeoutMs: waitMs }), waitMs + 500, timedOut)
      .catch(() => withTimeout(paseo.providers.snapshot({ cwd: project.path }), left(5_000), timedOut));
  }
  return {
    projects, project,
    providers: catalog.entries.filter(p => p.enabled !== false).map(p => {
      const models = (p.models ?? []).filter(m => m.isSelectable !== false).map(m => ({
        id: m.id, label: m.label || m.id, isDefault: Boolean(m.isDefault),
        thinkingOptions: (m.thinkingOptions ?? []).map(o => ({ id: o.id, label: o.label })),
        defaultThinkingOptionId: m.defaultThinkingOptionId ?? m.thinkingOptions?.find(o => o.isDefault)?.id ?? null,
      }));
      // The SDK requires provider/model; the daemon normalizes "default" to the provider's configured model.
      if (p.status === "ready" && !models.length) models.push({ id: "default", label: t("serverLaunch.defaultModel"), isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null });
      return {
        id: p.provider, label: p.label || p.provider, status: p.status, error: p.error ? clip(p.error) : null, models,
        modes: (p.modes ?? []).map(m => ({ id: m.id, label: m.label })), defaultModeId: p.defaultModeId ?? null,
      };
    }),
    // Never return daemon credentials, environment, or provider config to the client.
    profiles: (settings.config.agentProfiles ?? []).map(p => ({
      id: p.id, name: p.name, provider: p.provider, model: p.model ?? null,
      modeId: p.modeId ?? null, thinkingOptionId: p.thinkingOptionId ?? null,
    })),
  };
}

/** A launch is asynchronous, journaled before mutations, and never blindly retried. */
export class LaunchService {
  private accepting = new Map<string, Promise<LaunchReceipt>>();
  private active = new Map<string, { record: Journal; done: Promise<void> }>();
  private stopping = false;
  constructor(private readonly boards: BoardStore, private readonly projects = new ProjectDirectory(), private readonly root = path.join(defaultStorageRoot(), "..", "launches")) {}

  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error(t("serverLaunch.invalidId"));
    return path.join(this.root, id + ".json");
  }
  private async read(id: string): Promise<Journal | null> {
    try { return journalSchema.parse(JSON.parse(await readFile(this.file(id), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(t("serverLaunch.journalReadFailed")); }
  }
  private async save(record: Journal) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // A unique temp file: an overlapping writer (e.g. the old process during a reload) must not interleave bytes.
    const target = this.file(record.launchId), tmp = `${target}.${randomUUID()}.tmp`;
    try {
      const h = await open(tmp, "wx", 0o600);
      try { await h.writeFile(JSON.stringify(record, null, 2) + "\n"); await h.sync(); }
      finally { await h.close(); }
      await rename(tmp, target);
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(tmp).catch(() => {}); }
  }
  private receipt(record: Journal, replayed = false): LaunchReceipt {
    const { inputHash: _hash, projectId: _project, isolation: _isolation, itemId: _item, sourceProjectId: _source, createdAt: _created, ...receipt } = record;
    // Room for the capped cause plus the guidance after it; also caps records written before the cap existed.
    return { ...receipt, error: receipt.error === null ? null : clip(receipt.error, MAX_ERROR_CHARS + 100), replayed };
  }
  private checkAlive() { if (this.stopping) throw new Error(t("serverLaunch.reloading")); }

  async status(id: string, paseo?: Paseo): Promise<LaunchReceipt | null> {
    let record = await this.read(id);
    const running = this.active.get(id);
    // rename exposes the terminal journal before directory fsync and run cleanup finish. Wait for our own terminal
    // save before returning it or recovering IDs; another process's terminal record must not await our ongoing RPCs.
    if (record && terminal(record.stage) && running && terminal(running.record.stage)) {
      await running.done;
      record = await this.read(id);
    }
    if (!record) return null;
    if (record.stage !== "started" && record.stage !== "rejected" && !this.active.has(id) && !this.accepting.has(id)) {
      // Interrupted or an uncertain reply: look up, never create or send, what the daemon already made.
      let lookupComplete = false, agentLookupComplete = Boolean(record.agentId), found: { agentId: string; workspaceId: string | null } | null = null;
      let workspaceId = record.workspaceId, projectId = record.projectId, isolation = record.isolation;
      if (paseo && !record.agentId) {
        try {
          found = await this.findAgent(paseo, id);
          workspaceId ??= found?.workspaceId ?? null;
          agentLookupComplete = true;
        } catch { /* A failed lookup is not proof that no resource exists. */ }
      }
      if (paseo && !workspaceId && !found && !record.agentId && isolation !== "local") {
        try {
          const result = await this.findWorkspace(paseo, id, projectId);
          workspaceId = result.workspace?.id ?? null;
          if (result.workspace) { projectId = result.workspace.projectId; isolation = "worktree"; }
          lookupComplete = agentLookupComplete && result.complete;
        } catch { /* Keep uncertain when a complete read-only scan is unavailable. */ }
      }
      const latest = await this.read(id);
      if (latest && (latest.stage !== record.stage || latest.workspaceId !== record.workspaceId || latest.agentId !== record.agentId)) return this.receipt(latest, true);
      if (record.stage === "prepared" && record.projectId && isolation === "worktree" && lookupComplete && !workspaceId && !found && !record.agentId) {
        const rejected: Journal = { ...record, stage: "rejected", error: t("serverLaunch.interruptedBeforeCreate") };
        await this.save(rejected);
        return this.receipt(rejected, true);
      }
      const recovered: Journal = { ...record, projectId, isolation, workspaceId, agentId: record.agentId ?? found?.agentId ?? null, stage: "uncertain", error: record.stage === "uncertain" ? record.error : t("serverLaunch.interruptedUncertain") };
      // Persist recovered identifiers at every interrupted stage, including a lost workspace.create reply.
      if (found || workspaceId !== record.workspaceId) await this.save(recovered);
      return this.receipt(recovered, true);
    }
    return this.receipt(record, true);
  }
  private async findAgent(paseo: Paseo, id: string): Promise<{ agentId: string; workspaceId: string | null } | null> {
    const result = await withTimeout(paseo.agents.list({ filter: { labels: { [LAUNCH_LABEL]: id }, includeArchived: true }, page: { limit: 5 } }), 5_000, t("serverLaunch.agentLookupTimeout"));
    const agent = result.entries.find(entry => entry.agent.labels?.[LAUNCH_LABEL] === id)?.agent;
    return agent ? { agentId: agent.id, workspaceId: agent.workspaceId ?? null } : null;
  }
  private async findWorkspace(paseo: Paseo, id: string, projectId?: string) {
    const end = Date.now() + 12_000, slug = `notes-${launchSuffix(id)}`;
    let cursor: string | undefined;
    const visited = new Set<string>();
    // query searches name/projectId/id, not worktreeSlug. Old journals lack projectId: scan all pages safely.
    for (let page = 0; page < 100 && Date.now() < end; page++) {
      const result = await withTimeout(paseo.workspaces.list({
        ...(projectId ? { filter: { projectId } } : {}), page: { limit: 100, ...(cursor ? { cursor } : {}) },
      }), Math.min(5_000, end - Date.now()), t("serverLaunch.workspaceLookupTimeout"));
      const workspace = result.entries.find(entry => entry.worktreeSlug === slug && (!projectId || entry.projectId === projectId));
      if (workspace) return { workspace, complete: true };
      if (!result.pageInfo.hasMore) return { workspace: null, complete: true };
      const next = result.pageInfo.nextCursor;
      if (!next || visited.has(next)) break;
      visited.add(next); cursor = next;
    }
    return { workspace: null, complete: false };
  }

  async start(raw: LaunchInput, paseo: Paseo): Promise<LaunchReceipt> {
    const input = launchInputSchema.parse(raw);
    const ongoing = this.accepting.get(input.launchId);
    if (ongoing) {
      await ongoing;
      const stored = await this.read(input.launchId);
      if (!stored || stored.inputHash !== this.hash(input)) throw new Error(t("serverLaunch.idReused"));
      return this.receipt(stored, true);
    }
    const operation = this.accept(input, paseo);
    this.accepting.set(input.launchId, operation);
    try { return await operation; }
    finally { if (this.accepting.get(input.launchId) === operation) this.accepting.delete(input.launchId); }
  }
  private hash(input: LaunchInput) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

  private async accept(input: LaunchInput, paseo: Paseo): Promise<LaunchReceipt> {
    this.checkAlive();
    const existing = await this.read(input.launchId);
    if (existing) {
      if (existing.inputHash !== this.hash(input)) throw new Error(t("serverLaunch.idReusedCheck"));
      return (await this.status(input.launchId, paseo))!;
    }
    const record: Journal = { launchId: input.launchId, inputHash: this.hash(input), projectId: input.projectId, isolation: input.isolation, itemId: input.itemId, sourceProjectId: input.sourceProjectId, createdAt: new Date().toISOString(), stage: "prepared", workspaceId: null, agentId: null, error: null };
    await this.save(record);
    const run = Promise.resolve().then(() => this.run(record, input, paseo));
    this.active.set(input.launchId, { record, done: run });
    void run.finally(() => { if (this.active.get(input.launchId)?.done === run) this.active.delete(input.launchId); });
    return this.receipt(record);
  }

  private async validate(input: LaunchInput, paseo: Paseo): Promise<Prepared> {
    const board = await this.boards.read(input.sourceProjectId);
    const note = board.items.find(x => x.id === input.itemId && !x.deletedAt);
    if (!note) throw new Error(t("serverLaunch.noteMissing"));
    const options = await loadLaunchOptions(paseo, input.projectId, () => this.projects.list(paseo, true));
    if (!options.project) throw new Error(t("serverLaunch.projectMissing"));
    if (input.isolation === "worktree" && options.project.kind !== "git") throw new Error(t("serverLaunch.worktreeUnsupported"));
    if (input.baseBranch && (input.baseBranch.startsWith("-") || /[\r\n\0]/.test(input.baseBranch))) throw new Error(t("serverLaunch.invalidBranch"));
    const provider = options.providers.find(p => p.id === input.provider && p.status === "ready");
    if (!provider) throw new Error(t("serverLaunch.providerUnavailable"));
    const model = provider.models.find(m => m.id === input.model);
    if (!model) throw new Error(t("serverLaunch.modelUnavailable"));
    if (input.modeId && !provider.modes.some(m => m.id === input.modeId)) throw new Error(t("serverLaunch.modeUnavailable"));
    if (input.thinkingOptionId && !model.thinkingOptions.some(m => m.id === input.thinkingOptionId)) throw new Error(t("serverLaunch.thinkingUnavailable"));
    const sourceProject = input.sourceProjectId === INBOX_PROJECT_ID ? t("serverLaunch.inbox") : options.projects.find(project => project.id === input.sourceProjectId)?.name ?? input.sourceProjectId;
    const prepared: Prepared = { project: options.project, attachment: sourceAttachment(note, sourceProject) };
    if (input.profileId) {
      const { config } = await paseo.config.get();
      const profile = config.agentProfiles?.find(p => p.id === input.profileId);
      if (!profile || profile.provider !== input.provider || (profile.model && profile.model !== input.model) || (profile.modeId ?? null) !== (input.modeId ?? null) || (profile.thinkingOptionId ?? null) !== (input.thinkingOptionId ?? null)) {
        throw new Error(t("serverLaunch.profileChanged"));
      }
      prepared.featureValues = profile.featureValues;
    }
    return prepared;
  }

  private async run(record: Journal, input: LaunchInput, paseo: Paseo): Promise<void> {
    try {
      const prepared = await this.validate(input, paseo);
      this.checkAlive(); record.stage = "creating_workspace"; await this.save(record); this.checkAlive();
      const suffix = launchSuffix(input.launchId);
      // Daemon-side idempotency (0.9): replaying this launch can never create a second workspace or agent.
      const workspace = await paseo.workspaces.create({
        idempotencyKey: `project-notes:${input.launchId}:workspace`,
        title: input.title,
        source: input.isolation === "worktree" ? {
          kind: "worktree", projectId: prepared.project.id, cwd: prepared.project.path,
          action: "branch-off", branchName: `notes/${suffix}`, worktreeSlug: `notes-${suffix}`,
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        } : { kind: "directory", projectId: prepared.project.id, path: prepared.project.path },
      });
      record.workspaceId = workspace.id; record.stage = "workspace_ready"; await this.save(record);
      this.checkAlive(); record.stage = "creating_agent"; await this.save(record); this.checkAlive();
      const agent = await workspace.agents.create({
        idempotencyKey: `project-notes:${input.launchId}:agent`,
        config: {
          provider: `${input.provider}/${input.model}`,
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
          ...(prepared.featureValues ? { featureValues: prepared.featureValues } : {}),
        },
        title: input.title, autoArchive: false,
        labels: { [LAUNCH_LABEL]: input.launchId, [ITEM_LABEL]: input.itemId },
      });
      record.agentId = agent.id; record.stage = "agent_ready"; await this.save(record);
      this.checkAlive(); record.stage = "sending"; await this.save(record); this.checkAlive();
      await agent.send(input.prompt, { messageId: `project-notes-${input.launchId}`, attachments: [prepared.attachment] });
      record.stage = "started"; record.error = null; await this.save(record);
    } catch (e) {
      const noMutation = record.stage === "prepared";
      record.stage = noMutation ? "rejected" : "uncertain";
      const failure = noMutation ? "serverLaunch.failedBeforeCreate" : "serverLaunch.failedUncertain";
      // The receipt keeps its 600-character bound. Longer translations get room by trimming the cause first.
      const guidanceLength = Array.from(t(failure, { cause: "" })).length;
      const cause = clip(message(e), Math.max(1, Math.min(MAX_ERROR_CHARS, MAX_ERROR_CHARS + 100 - guidanceLength)));
      record.error = t(failure, { cause });
      try { await this.save(record); } catch { /* A prior durable stage still prevents automatic replay after restart. */ }
    }
  }
  /**
   * Launch records for task cards (every note, newest first) or one note's detail (`itemId`). Reads only this plugin's
   * own small record files: regular files, no symbolic links, at most 64 KiB, parsed again only after they change. The
   * revision covers what the list shows, so polling it answers `unchanged` cheaply. With `itemId` and a daemon, the
   * note's agents come from the agent directory by their note label (archived ones too), which also finds launches
   * whose records predate the note id. Never reads a timeline, so it wakes no unloaded agent.
   */
  async records(options: { itemId?: string; paseo?: Paseo } = {}): Promise<{ revision: string; records: LaunchRecord[]; agents?: LaunchAgent[] }> {
    // A launch this process no longer runs (a reload or crash cut it short) is uncertain, as status() would report it.
    const records = (await this.scanRecords()).map(record => PENDING_STAGES.has(record.stage) && !this.active.has(record.launchId) && !this.accepting.has(record.launchId) ? { ...record, stage: "uncertain" as const } : record);
    const revision = createHash("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16);
    if (!options.itemId) return { revision, records: records.filter(record => record.itemId !== null).slice(0, MAX_LISTED_RECORDS) };
    const agents = options.paseo ? await this.itemAgents(options.paseo, options.itemId) : [];
    const launched = new Set(agents.flatMap(agent => agent.launchId ? [agent.launchId] : []));
    return { revision, records: records.filter(record => record.itemId === options.itemId || (record.itemId === null && launched.has(record.launchId))), agents };
  }
  private scanned = new Map<string, { key: string; record: LaunchRecord | null }>();
  private async scanRecords(): Promise<LaunchRecord[]> {
    let names: string[];
    try { names = (await readdir(this.root)).filter(name => JOURNAL_FILE.test(name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") names = []; else throw e; }
    const seen = new Set(names), records: LaunchRecord[] = [];
    for (const name of [...this.scanned.keys()]) if (!seen.has(name)) this.scanned.delete(name);
    for (const name of names) {
      const record = await this.scanOne(name);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.at.localeCompare(a.at) || a.launchId.localeCompare(b.launchId));
  }
  private async scanOne(name: string): Promise<LaunchRecord | null> {
    let handle;
    try { handle = await open(path.join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { this.scanned.delete(name); return null; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_JOURNAL_BYTES) { this.scanned.delete(name); return null; }
      const key = `${info.ino}:${info.size}:${info.mtimeMs}`, cached = this.scanned.get(name);
      if (cached?.key === key) return cached.record;
      let record: LaunchRecord | null = null;
      try {
        const journal = journalSchema.parse(JSON.parse(await handle.readFile("utf8")));
        if (`${journal.launchId}.json` === name) {
          record = { launchId: journal.launchId, itemId: journal.itemId ?? null, stage: journal.stage, workspaceId: journal.workspaceId, agentId: journal.agentId,
            error: journal.error === null ? null : clip(journal.error, MAX_ERROR_CHARS + 100), at: journal.createdAt ?? info.mtime.toISOString() };
        }
      } catch { /* Not a launch record (or half written by an older version): leave it out. */ }
      this.scanned.set(name, { key, record });
      return record;
    } finally { await handle.close(); }
  }
  private async itemAgents(paseo: Paseo, itemId: string): Promise<LaunchAgent[]> {
    const result = await withTimeout(paseo.agents.list({ filter: { labels: { [ITEM_LABEL]: itemId }, includeArchived: true }, page: { limit: 50 } }), 5_000, t("serverLaunch.agentLookupTimeout"));
    return result.entries.filter(entry => entry.agent.labels?.[ITEM_LABEL] === itemId).map(({ agent }) => ({
      agentId: agent.id, launchId: agent.labels?.[LAUNCH_LABEL] ?? null, workspaceId: agent.workspaceId ?? null, title: agent.title ?? null,
      provider: agent.provider, status: agent.status, archivedAt: agent.archivedAt ?? null, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
    }));
  }
  async stop() {
    this.stopping = true;
    // Acceptance may still be writing prepared; wait for it to register its run before draining runs.
    await Promise.allSettled([...this.accepting.values()]);
    await Promise.allSettled([...this.active.values()].map(run => run.done));
  }
}
