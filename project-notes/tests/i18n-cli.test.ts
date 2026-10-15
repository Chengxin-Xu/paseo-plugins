import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindTranslator, createTranslator } from "../shared/i18n";
import { BUILTIN_CATALOGS } from "../server/locales";
import { loadCliLanguage, parseArgs, runCli, usage, type CliDeps } from "../server/cli";
import { BoardStore } from "../server/store";

const homes: string[] = [];
afterEach(async () => {
  bindTranslator(createTranslator("zh-CN", BUILTIN_CATALOGS["zh-CN"]));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture(state?: unknown, locales: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), "notes-i18n-")); homes.push(home);
  const base = join(home, "plugin-data", "project-notes");
  await mkdir(join(base, "locales"), { recursive: true });
  if (state !== undefined) await writeFile(join(base, "i18n-state.json"), JSON.stringify(state));
  for (const [code, catalog] of Object.entries(locales)) await writeFile(join(base, "locales", `${code}.json`), JSON.stringify(catalog));
  const output: string[] = [];
  const env = { PASEO_HOME: home };
  const store = new BoardStore(join(base, "boards"));
  const deps: CliDeps = { store, env, cwd: home, loadProjects: async () => [], stdout: text => { output.push(text); }, readStdin: async () => "" };
  return { env, store, deps, output };
}

describe("standalone CLI language", () => {
  it("follows the saved device language and applies it to terminal output and store errors", async () => {
    const { env, store, deps, output } = await fixture({ setting: "auto", device: "en-US" });
    expect(await loadCliLanguage(env)).toBe("en");
    await runCli(["list"], deps);
    expect(output.join("")).toBe("(No matching notes)\n");
    expect(usage()).toMatch(/^Project Notes CLI\n/);
    await expect(store.read("")).rejects.toThrow("Invalid project");
  });

  it("prefers the explicit plugin setting over the device", async () => {
    const { env } = await fixture({ setting: "zh-CN", device: "en-US" });
    expect(await loadCliLanguage(env)).toBe("zh-CN");
    expect(usage()).toMatch(/^拾页 · 项目手记 命令行\n/);
    expect(() => parseArgs(["add", "--title"])).toThrow("--title 需要一个值。");
  });

  it("falls back from an unavailable setting to the device, then to English", async () => {
    const chinese = await fixture({ setting: "fr", device: "zh-Hans-CN" });
    expect(await loadCliLanguage(chinese.env)).toBe("zh-CN");
    const unknown = await fixture({ setting: "fr", device: "de-DE" });
    expect(await loadCliLanguage(unknown.env)).toBe("en");
    const fresh = await fixture();
    expect(await loadCliLanguage(fresh.env)).toBe("en");
  });

  it("uses a custom language and falls back to English for missing or invalid messages", async () => {
    const { env, deps, output } = await fixture({ setting: "ko", device: "zh-CN" }, {
      ko: { $meta: { name: "한국어" }, cli: { empty: "일치하는 메모가 없습니다", optionNeedsValue: "{unknown} 값 필요" } },
    });
    expect(await loadCliLanguage(env)).toBe("ko");
    await runCli(["list"], deps);
    expect(output.join("")).toBe("일치하는 메모가 없습니다\n");
    expect(() => parseArgs(["add", "--title"])).toThrow("--title requires a value.");
    expect(usage()).toMatch(/^Project Notes CLI\n/);
  });

  it("applies valid user overrides to built-in languages", async () => {
    const { env, deps, output } = await fixture({ setting: "en", device: "zh-CN" }, {
      en: { cli: { empty: "Nothing saved here" } },
    });
    expect(await loadCliLanguage(env)).toBe("en");
    await runCli(["list"], deps);
    expect(output.join("")).toBe("Nothing saved here\n");
    expect(() => parseArgs(["add", "--title"])).toThrow("--title requires a value.");
  });

  it("uses English plural rules for missing messages in a Korean custom catalog", async () => {
    const { env, store, deps, output } = await fixture({ setting: "ko", device: "en" }, {
      ko: { cli: { empty: "일치하는 메모가 없습니다" } },
    });
    vi.spyOn(store, "readEntries").mockResolvedValue({ entries: [], unavailable: [
      { file: "unavailable.json", projectId: "project-one", bytes: 33 * 1024 * 1024, reason: "file" },
    ] });
    expect(await loadCliLanguage(env)).toBe("ko");
    await runCli(["list"], deps);
    expect(output.join("")).toContain("Notes from 1 other project were not read:");
    expect(output.join("")).not.toContain("1 other projects");
  });

  it("translates human kind and status labels while retaining JSON command tokens", async () => {
    const { env, deps, output } = await fixture({ setting: "ko", device: "en" }, {
      ko: { cli: { kindTask: "작업", statusTodo: "대기" } },
    });
    await loadCliLanguage(env);
    await runCli(["add", "--project", "inbox", "--title", "Keep the source", "--json"], deps);
    const created = JSON.parse(output.join("")); output.length = 0;
    await runCli(["show", created.itemId], deps);
    expect(output.join("")).toContain("작업");
    expect(output.join("")).toContain("대기");
    output.length = 0;
    await runCli(["show", created.itemId, "--json"], deps);
    expect(JSON.parse(output.join(""))).toMatchObject({ kind: "task", status: "todo", title: "Keep the source" });
  });
});
