import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { BoardStore } from "./store";
import { boardProjects, type ProjectDirectory } from "./dashboard";
import { noteContext, templateVariables, type ComposerNote } from "../shared/composer";

const LIMIT = 40;
/** The store caches JSON; normalized search text is rebuilt only for boards whose content token changed. */
export class ComposerLibrary {
  private indexes = new Map<string, { token: string; items: { item: ComposerNote; search: string }[]; name: string }>();
  constructor(private readonly store: BoardStore, private readonly projects: ProjectDirectory) {}
  async search(paseo: PluginHandlerContext["paseo"], query: string, promptsOnly: boolean) {
    const [{ entries, unavailable }, projects] = await Promise.all([this.store.readEntries(), this.projects.list(paseo)]);
    const names = new Map(boardProjects(projects).map(project => [project.id, project.name]));
    const live = new Set(entries.map(entry => entry.snapshot.projectId));
    for (const id of this.indexes.keys()) if (!live.has(id)) this.indexes.delete(id);
    const needle = query.trim().toLocaleLowerCase();
    const found: ComposerNote[] = [];
    for (const entry of entries) {
      const id = entry.snapshot.projectId, name = names.get(id) ?? "历史项目";
      let index = this.indexes.get(id);
      if (!index || index.token !== entry.token || index.name !== name) {
        index = { token: entry.token, name, items: entry.snapshot.items.filter(item => !item.deletedAt).map(item => ({ item: { ...item, projectName: name }, search: `${item.title}\n${item.body}\n${name}`.toLocaleLowerCase() })) };
        this.indexes.set(id, index);
      }
      for (const entry of index.items) if ((!promptsOnly || entry.item.kind === "prompt") && (!needle || entry.search.includes(needle))) found.push(entry.item);
    }
    found.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { items: found.slice(0, LIMIT), truncated: found.length > LIMIT, unavailable: unavailable.length };
  }
  async attachments(paseo: PluginHandlerContext["paseo"], query: string) {
    const result = await this.search(paseo, query, false);
    return { items: result.items.map(item => ({
      id: `${item.projectId}:${item.id}`, identifier: `手记 #${item.id.slice(0, 8)}`, title: item.title,
      subtitle: `${item.projectName} · ${{ task: "任务", prompt: "提示词", idea: "想法" }[item.kind]}${templateVariables(item.body).length ? " · 含模板变量，请先在提示词胶囊填参" : ""}`,
      url: `paseo-notes://note/${encodeURIComponent(item.projectId)}/${item.id}`,
      text: noteContext(item), resourceType: "项目手记",
    })) };
  }
}
