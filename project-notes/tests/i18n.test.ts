import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { auditCatalogs, findMessageIds, findUntranslated } from "../server/i18n-audit";
import { bindTranslator, catalogIds, createTranslator } from "../shared/i18n";
import { createLocaleService } from "../server/i18n-server";
import { BUILTIN_CATALOGS } from "../server/locales";
import { BoardStore } from "../server/store";
import { runCli } from "../server/cli";
import { t } from "../shared/text";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";

const root = resolve(import.meta.dirname, "..");
const homes: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  bindTranslator(createTranslator("zh-CN", BUILTIN_CATALOGS["zh-CN"]));
});
const temporary = async () => { const home = await mkdtemp(join(tmpdir(), "notes-i18n-")); homes.push(home); return home; };

describe("message catalogs", () => {
  it("has matching ids and placeholders with no untranslated source literals", () => {
    expect(auditCatalogs({ zh, en })).toEqual([]);
    expect(findUntranslated(root)).toEqual([]);
  });
  it("uses every message and references only existing ids", () => {
    const named = findMessageIds(root, zh), ids = catalogIds(zh);
    // No dynamic message prefixes: every call names a complete id.
    const dynamicPrefixes: string[] = [];
    expect(ids.filter(id => !named.has(id) && !dynamicPrefixes.some(prefix => id.startsWith(prefix)))).toEqual([]);
    expect([...named].filter(id => !ids.includes(id))).toEqual([]);
  });
  it("renders English registration, settings and server/CLI output", async () => {
    bindTranslator(createTranslator("en", BUILTIN_CATALOGS.en));
    expect(t("boot.screenTitle")).toBe("Project Notes");
    expect(t("boot.settingsTitle")).toBe("Language");
    expect(t("settings.description")).toBe("Tasks, prompts and ideas organized by project.");
    const output: string[] = [];
    await runCli(["--help"], { store: new BoardStore(await temporary()), loadProjects: async () => [], stdout: value => output.push(value), readStdin: async () => "", cwd: "/", env: {} });
    expect(output.join("")).toContain("--project");
    expect(output.join("")).not.toMatch(/[一-鿿]/);
  });
});

it("serves English by device, switches Chinese, validates user languages and restores the choice", async () => {
  const home = await temporary();
  let language = "auto";
  const observers = new Set<(state: any) => void>();
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    handle(contract: { name: string }, handler: any) { handlers.set(contract.name, handler); },
    registerSettings() { return {
      read: async () => ({ status: "ready", values: { language } }),
      subscribe(listener: (state: any) => void) { observers.add(listener); return () => { observers.delete(listener); }; },
    }; },
  } as unknown as PluginServerContext;
  let service = createLocaleService(server, { pluginId: "project-notes", builtins: BUILTIN_CATALOGS, home });
  stops.push(() => service.dispose());
  await service.ready;
  const catalog = async (device = "en-US") => {
    const first = await handlers.get("i18n.catalog")!({ device, part: 0 });
    let text = first.text;
    for (let part = 1; part < first.parts; part++) text += (await handlers.get("i18n.catalog")!({ device, part, hash: first.hash })).text;
    return { language: first.language, catalog: JSON.parse(text) };
  };
  const choose = (next: string) => { language = next; for (const observer of observers) observer({ status: "ready", values: { language } }); };
  expect((await catalog()).catalog.boot.screenTitle).toBe(en.boot.screenTitle);
  choose("zh-CN");
  expect((await catalog()).catalog.boot.screenTitle).toBe(zh.boot.screenTitle);
  const folder = join(home, "plugin-data/project-notes/locales");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "ko.json"), JSON.stringify({ $meta: { name: "한국어" }, boot: { screenTitle: "프로젝트 노트", name: "{invalid}" } }));
  const listed = await handlers.get("i18n.languages")!({ device: "en-US" });
  const korean = listed.languages.find((item: any) => item.code === "ko");
  expect(korean.coverage).toBeGreaterThan(0);
  expect(korean.coverage).toBeLessThan(1);
  expect(korean.issues).toHaveLength(1);
  choose("ko");
  const custom = await catalog();
  expect(custom.language).toBe("ko");
  expect(custom.catalog.boot.screenTitle).toBe("프로젝트 노트");
  expect(custom.catalog.boot.name).toBe(en.boot.name);
  await expect.poll(async () => JSON.parse(await readFile(join(home, "plugin-data/project-notes/i18n-state.json"), "utf8")).setting).toBe("ko");
  service.dispose();
  service = createLocaleService(server, { pluginId: "project-notes", builtins: BUILTIN_CATALOGS, home });
  await service.ready;
  expect((await catalog()).catalog.boot.screenTitle).toBe("프로젝트 노트");
});
