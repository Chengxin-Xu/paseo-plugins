import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { completionSnoozeSchema, defaultViewPreferences, getPreferences, savedViewSchema, updatePreferences, viewPreferencesSchema,
  type CompletionSnooze, type PreferencesSnapshot, type PreferencesUpdate, type PreferencesUpdateResult, type SavedView, type ViewPreferences } from "../shared/preferences";
import { telemetryDirectory } from "./telemetry";
import { ensurePrivateDirectory } from "./paseo-home";

const storedViewSchema = z.object({ key: z.string().min(1).max(256), updatedAt: z.iso.datetime({ offset: true }), view: viewPreferencesSchema, savedViews: z.array(savedViewSchema).max(12) });
const fileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), views: z.array(storedViewSchema).max(32), snoozes: z.array(completionSnoozeSchema).max(2000) });
type StoredView = z.infer<typeof storedViewSchema>;

export class PreferencesStore {
  private readonly directory: string;
  private readonly file: string;
  private readonly now: () => number;
  private revision = 0;
  private views = new Map<string, StoredView>();
  private snoozes: CompletionSnooze[] = [];
  private error: string | null = null;
  private corrupt = false;
  private closed = false;
  private mutations: Promise<void>;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.directory = options.directory ?? telemetryDirectory(); this.file = join(this.directory, "preferences.json");
    this.now = options.now ?? Date.now; this.mutations = this.load();
  }

  private async load() {
    try {
      if ((await stat(this.file)).size > 32_000_000) throw new Error("preferences exceed storage limit");
      const data = fileSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      this.revision = data.revision;
      for (const view of data.views) this.views.set(view.key, view);
      this.snoozes = data.snoozes;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        this.corrupt = true;
        this.error = "已保存的偏好无法读取；下次保存时会保留一份损坏文件备份。";
      }
    }
  }

  private current(viewKey: string): PreferencesSnapshot {
    const stored = this.views.get(viewKey);
    // The live view never carries search text (older clients saved it and it followed people to other devices); saved views keep theirs.
    return structuredClone({ revision: this.revision, view: { ...(stored?.view ?? defaultViewPreferences(viewKey)), query: "" }, savedViews: stored?.savedViews ?? [],
      snoozes: this.snoozes.filter(snooze => Date.parse(snooze.until) > this.now()), error: this.error });
  }

  async get(viewKey: string): Promise<PreferencesSnapshot> {
    getPreferences.input.parse({ viewKey });
    await this.mutations;
    return this.current(viewKey);
  }

  async update(input: PreferencesUpdate): Promise<PreferencesUpdateResult> {
    if (this.closed) throw new Error("偏好服务正在关闭，请稍后重试。");
    const validated = updatePreferences.input.parse(input);
    const task = this.mutations.then(() => this.apply(validated));
    this.mutations = task.then(() => {}, () => {});
    return task;
  }

  private async apply(input: PreferencesUpdate): Promise<PreferencesUpdateResult> {
    if (input.expectedRevision !== this.revision) return { status: "conflict", ...this.current(input.viewKey) };
    const now = this.now(), at = new Date(now).toISOString();
    const old = this.views.get(input.viewKey);
    const view: ViewPreferences = { ...(old?.view ?? defaultViewPreferences(input.viewKey)), ...input.view, query: "" };
    view.expanded = [...new Set(view.expanded)];
    let savedViews: SavedView[] = old ? structuredClone(old.savedViews) : [];
    let snoozes = this.snoozes.filter(snooze => Date.parse(snooze.until) > now);
    if (input.deleteSavedViewId) savedViews = savedViews.filter(saved => saved.id !== input.deleteSavedViewId);
    if (input.saveView) {
      const existing = input.saveView.id ? savedViews.find(saved => saved.id === input.saveView!.id) : undefined;
      if (input.saveView.id && !existing) throw new Error("要更新的保存视图已不存在，请刷新后重试。");
      if (savedViews.some(saved => saved.name === input.saveView!.name && saved.id !== existing?.id)) throw new Error("已有同名视图，请选择另一个名称。");
      if (!existing && savedViews.length >= 12) throw new Error("每个页面最多保存 12 个视图，请先删除不再使用的视图。");
      const saved: SavedView = { id: existing?.id ?? randomUUID(), name: input.saveView.name, createdAt: existing?.createdAt ?? at, updatedAt: at,
        view: { ...input.saveView.view, expanded: [...new Set(input.saveView.view.expanded)] } };
      savedViews = [saved, ...savedViews.filter(candidate => candidate.id !== saved.id)];
    }
    if (input.unsnooze) snoozes = snoozes.filter(snooze => snooze.agentId !== input.unsnooze!.agentId || Date.parse(snooze.completionAt) !== Date.parse(input.unsnooze!.completionAt));
    if (input.snooze) {
      const until = Date.parse(input.snooze.until);
      if (until <= now || until > now + 30 * 86_400_000) throw new Error("稍后提醒时间应在现在之后、30 天以内。");
      if (Date.parse(input.snooze.completionAt) > now) throw new Error("不能稍后提醒尚未发生的完成结果。");
      snoozes = snoozes.filter(snooze => snooze.agentId !== input.snooze!.agentId || Date.parse(snooze.completionAt) !== Date.parse(input.snooze!.completionAt));
      if (snoozes.length >= 2000) throw new Error("稍后提醒已达到 2,000 条保留上限，请先取消部分提醒。");
      snoozes.unshift({ ...input.snooze });
    }
    const changed = JSON.stringify(old?.view ?? defaultViewPreferences(input.viewKey)) !== JSON.stringify(view)
      || JSON.stringify(old?.savedViews ?? []) !== JSON.stringify(savedViews) || JSON.stringify(this.snoozes) !== JSON.stringify(snoozes);
    if (!changed) return { status: "updated", ...this.current(input.viewKey) };
    if (!old && this.views.size >= 32) {
      const oldest = [...this.views.values()].filter(view => view.savedViews.length === 0).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!oldest) throw new Error("已达到 32 个页面偏好上限，请先移除不再使用的保存视图。");
      this.views.delete(oldest.key);
    }
    this.views.set(input.viewKey, { key: input.viewKey, updatedAt: at, view, savedViews });
    this.snoozes = snoozes; this.revision += 1;
    await this.persist();
    return { status: "updated", ...this.current(input.viewKey) };
  }

  private async persist() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await ensurePrivateDirectory(this.directory);
      if (this.corrupt) { try { await rename(this.file, `${this.file}.corrupt`); } catch { /* unreadable/absent original */ } this.corrupt = false; }
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, revision: this.revision, views: [...this.views.values()], snoozes: this.snoozes }), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.file); this.error = null;
    } catch { this.error = "偏好已在内存更新，但暂时无法写入磁盘；重启后可能丢失本次变更。"; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async close() { this.closed = true; await this.mutations; }
}

export function registerPreferences(server: PluginServerContext): () => Promise<void> {
  const store = new PreferencesStore();
  server.handle(getPreferences, ({ viewKey }) => store.get(viewKey));
  server.handle(updatePreferences, input => store.update(input));
  return () => store.close();
}
