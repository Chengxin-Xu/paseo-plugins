import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { launchInputSchema, launchReceiptSchema, type LaunchInput, type LaunchOptions, type LaunchReceipt } from "../shared/launch";
import { ProjectDirectory, withTimeout, type PaseoProject } from "./dashboard";
import { BoardStore, defaultStorageRoot } from "./store";

type Paseo = PluginHandlerContext["paseo"];
type ListProjects = () => Promise<PaseoProject[]>;
const journalSchema = launchReceiptSchema.omit({ replayed: true }).extend({ inputHash: z.string() });
type Journal = z.infer<typeof journalSchema>;
type Prepared = { project: LaunchOptions["projects"][number]; featureValues?: Record<string, unknown> };
const message = (e: unknown) => e instanceof Error ? e.message : "操作未完成";
/** Per-call timeouts that together stay inside the host's 30 s plugin RPC limit. */
function budget(totalMs: number) { const end = Date.now() + totalMs; return (maxMs: number) => Math.max(1, Math.min(maxMs, end - Date.now())); }

function absoluteDirectory(value: string) {
  if (!path.isAbsolute(value)) throw new Error("项目路径不是此主机的绝对路径，请重新选择项目。");
  return value;
}

export async function loadLaunchOptions(paseo: Paseo, projectId?: string, listProjects: ListProjects = async () => (await paseo.projects.list()).projects): Promise<LaunchOptions> {
  const left = budget(24_000);
  const projects = (await listProjects()).map(p => ({ id: p.projectId, name: p.projectDisplayName, path: p.projectRootPath, kind: p.projectKind }));
  const project = projects.find(p => p.id === projectId) ?? null;
  if (!project) return { projects, project: null, providers: [], profiles: [] };
  absoluteDirectory(project.path);
  const timedOut = "读取代理选项超时，请稍后重新读取。";
  const [initialCatalog, settings] = await Promise.all([
    withTimeout(paseo.providers.snapshot({ cwd: project.path }), left(9_000), timedOut),
    withTimeout(paseo.config.get(), left(6_000), timedOut),
  ]);
  let catalog = initialCatalog;
  if (!catalog.entries.some(p => p.enabled !== false && p.status === "ready" && p.models?.length)) {
    const waitMs = Math.max(1, left(8_000) - 500);
    catalog = await withTimeout(paseo.providers.waitForReady({ cwd: project.path, timeoutMs: waitMs }), waitMs + 500, timedOut)
      .catch(() => withTimeout(paseo.providers.snapshot({ cwd: project.path }), left(5_000), timedOut));
  }
  return {
    projects, project,
    providers: catalog.entries.filter(p => p.enabled !== false).map(p => ({
      id: p.provider, label: p.label || p.provider, status: p.status, error: p.error ?? null,
      models: (p.models ?? []).filter(m => m.isSelectable !== false).map(m => ({
        id: m.id, label: m.label || m.id, isDefault: Boolean(m.isDefault),
        thinkingOptions: (m.thinkingOptions ?? []).map(o => ({ id: o.id, label: o.label })),
        defaultThinkingOptionId: m.defaultThinkingOptionId ?? m.thinkingOptions?.find(o => o.isDefault)?.id ?? null,
      })),
      modes: (p.modes ?? []).map(m => ({ id: m.id, label: m.label })), defaultModeId: p.defaultModeId ?? null,
    })),
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
  private active = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(private readonly boards: BoardStore, private readonly projects = new ProjectDirectory(), private readonly root = path.join(defaultStorageRoot(), "..", "launches")) {}

  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error("无效的启动标识");
    return path.join(this.root, id + ".json");
  }
  private async read(id: string): Promise<Journal | null> {
    try { return journalSchema.parse(JSON.parse(await readFile(this.file(id), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("启动记录读取失败；请检查已有工作区，不要重复创建。"); }
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
    const { inputHash: _hash, ...receipt } = record;
    return { ...receipt, replayed };
  }
  private checkAlive() { if (this.stopping) throw new Error("插件正在重载，启动流程已停止；检查现有工作区后再继续。"); }

  async status(id: string, paseo?: Paseo): Promise<LaunchReceipt | null> {
    const record = await this.read(id);
    if (!record) return null;
    if (record.stage !== "started" && record.stage !== "uncertain" && record.stage !== "rejected" && !this.active.has(id) && !this.accepting.has(id)) {
      // Interrupted (e.g. plugin reload). Look up, never create, what the daemon already made.
      const found = record.agentId || !paseo ? null : await this.findAgent(paseo, id).catch(() => null);
      return this.receipt({ ...record, workspaceId: record.workspaceId ?? found?.workspaceId ?? null, agentId: record.agentId ?? found?.agentId ?? null, stage: "uncertain", error: "启动流程已中断。已有工作区或会话可能仍在，请先打开检查；不会自动重复创建。" }, true);
    }
    return this.receipt(record, true);
  }
  private async findAgent(paseo: Paseo, id: string): Promise<{ agentId: string; workspaceId: string | null } | null> {
    const result = await withTimeout(paseo.agents.list({ filter: { labels: { "project-notes.launch-id": id }, includeArchived: true }, page: { limit: 5 } }), 5_000, "查询已创建会话超时");
    const agent = result.entries.find(entry => entry.agent.labels?.["project-notes.launch-id"] === id)?.agent;
    return agent ? { agentId: agent.id, workspaceId: agent.workspaceId ?? null } : null;
  }

  async start(raw: LaunchInput, paseo: Paseo): Promise<LaunchReceipt> {
    const input = launchInputSchema.parse(raw);
    const ongoing = this.accepting.get(input.launchId);
    if (ongoing) {
      await ongoing;
      const stored = await this.read(input.launchId);
      if (!stored || stored.inputHash !== this.hash(input)) throw new Error("该启动标识已经用于不同内容。");
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
      if (existing.inputHash !== this.hash(input)) throw new Error("该启动标识已经用于不同内容，请先检查已有会话。");
      return (await this.status(input.launchId, paseo))!;
    }
    const record: Journal = { launchId: input.launchId, inputHash: this.hash(input), stage: "prepared", workspaceId: null, agentId: null, error: null };
    await this.save(record);
    const run = Promise.resolve().then(() => this.run(record, input, paseo));
    this.active.set(input.launchId, run);
    void run.finally(() => { if (this.active.get(input.launchId) === run) this.active.delete(input.launchId); });
    return this.receipt(record);
  }

  private async validate(input: LaunchInput, paseo: Paseo): Promise<Prepared> {
    const board = await this.boards.read(input.sourceProjectId);
    if (!board.items.some(x => x.id === input.itemId && !x.deletedAt)) throw new Error("这条手记已删除或不存在，请刷新后重新选择。");
    const options = await loadLaunchOptions(paseo, input.projectId, () => this.projects.list(paseo, true));
    if (!options.project) throw new Error("目标项目已经不存在，请选择当前主机上的项目。");
    if (input.isolation === "worktree" && options.project.kind !== "git") throw new Error("这个项目不支持 Git worktree，请选择 Local 工作区。");
    if (input.baseBranch && (input.baseBranch.startsWith("-") || /[\r\n\0]/.test(input.baseBranch))) throw new Error("起始分支格式无效");
    const provider = options.providers.find(p => p.id === input.provider && p.status === "ready");
    if (!provider) throw new Error("所选 provider 当前不可用，请刷新模型列表。");
    const model = provider.models.find(m => m.id === input.model);
    if (!model) throw new Error("所选模型当前不可用，请重新选择。");
    if (input.modeId && !provider.modes.some(m => m.id === input.modeId)) throw new Error("所选权限模式已不可用，请重新选择。");
    if (input.thinkingOptionId && !model.thinkingOptions.some(m => m.id === input.thinkingOptionId)) throw new Error("所选思考档位已不可用，请重新选择。");
    const prepared: Prepared = { project: options.project };
    if (input.profileId) {
      const { config } = await paseo.config.get();
      const profile = config.agentProfiles?.find(p => p.id === input.profileId);
      if (!profile || profile.provider !== input.provider || (profile.model && profile.model !== input.model) || (profile.modeId ?? null) !== (input.modeId ?? null) || (profile.thinkingOptionId ?? null) !== (input.thinkingOptionId ?? null)) {
        throw new Error("Profile 已变化，或与所选模型/模式不一致，请重新选择。");
      }
      prepared.featureValues = profile.featureValues;
    }
    return prepared;
  }

  private async run(record: Journal, input: LaunchInput, paseo: Paseo): Promise<void> {
    try {
      const prepared = await this.validate(input, paseo);
      this.checkAlive(); record.stage = "creating_workspace"; await this.save(record); this.checkAlive();
      const suffix = createHash("sha256").update(input.launchId).digest("hex").slice(0, 12);
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
        labels: { "project-notes.launch-id": input.launchId, "project-notes.item-id": input.itemId },
      });
      record.agentId = agent.id; record.stage = "agent_ready"; await this.save(record);
      this.checkAlive(); record.stage = "sending"; await this.save(record); this.checkAlive();
      await agent.send(input.prompt, { messageId: `project-notes-${input.launchId}` });
      record.stage = "started"; record.error = null; await this.save(record);
    } catch (e) {
      const noMutation = record.stage === "prepared";
      record.stage = noMutation ? "rejected" : "uncertain";
      record.error = noMutation ? `${message(e)}。尚未创建工作区或代理，可以修改选项后重试。` : `${message(e)}。工作区或会话可能已经创建，请先检查，不会自动重复启动。`;
      try { await this.save(record); } catch { /* A prior durable stage still prevents automatic replay after restart. */ }
    }
  }
  stop() { this.stopping = true; }
}
