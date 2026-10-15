import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { bindTranslator, createTranslator } from "../shared/i18n";
import { BUILTIN_CATALOGS } from "../server/locales";
import { BoardStore } from "../server/store";
import { ProjectDirectory } from "../server/dashboard";
import { LaunchService } from "../server/launch";

afterEach(() => bindTranslator(createTranslator("zh-CN", BUILTIN_CATALOGS["zh-CN"])));

it("keeps complete English recovery guidance after a long provider error within the receipt limit", async () => {
  bindTranslator(createTranslator("en", BUILTIN_CATALOGS.en));
  const root = await mkdtemp(join(tmpdir(), "notes-launch-i18n-"));
  const boards = new BoardStore(join(root, "boards")), projects = new ProjectDirectory();
  const service = new LaunchService(boards, projects, join(root, "launches"));
  try {
    const created = await boards.write({ projectId: "project-one", requestId: "english-source", operation: {
      type: "create", fields: { title: "Source", body: "Original text", kind: "task", status: "todo", priority: "normal", pinned: false },
    } });
    let attempted!: () => void;
    const workspaceAttempt = new Promise<void>(resolve => { attempted = resolve; });
    const paseo = {
      projects: { list: async () => ({ projects: [{ projectId: "project-one", projectDisplayName: "Example", projectRootPath: "/example", projectKind: "non_git" }] }), subscribe: () => () => {} },
      providers: { snapshot: async () => ({ entries: [{ provider: "example", status: "ready", models: [{ id: "default", label: "Default" }] }] }) },
      config: { get: async () => ({ config: { agentProfiles: [] } }) },
      workspaces: { create: async () => { attempted(); throw new Error("Provider failure ".repeat(100)); } },
    } as unknown as PluginHandlerContext["paseo"];
    await service.start({ launchId: "launch-english-guidance", sourceProjectId: "project-one", itemId: created.itemId, projectId: "project-one", isolation: "local", provider: "example", model: "default", title: "Source", prompt: "Original text" }, paseo);
    await workspaceAttempt;
    await service.stop();
    const receipt = await service.status("launch-english-guidance");
    expect(receipt?.stage).toBe("uncertain");
    expect(receipt?.error).toMatch(/…\. A workspace or session may already exist\. Check it first; the launch will not be retried automatically\.$/);
    expect(Array.from(receipt!.error!).length).toBeLessThanOrEqual(600);
  } finally {
    await service.stop(); projects.stop(); await rm(root, { recursive: true, force: true });
  }
});
