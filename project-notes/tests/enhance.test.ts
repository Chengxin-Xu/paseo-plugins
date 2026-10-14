import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { ProjectDirectory } from "../server/dashboard";
import { probeProject } from "../server/enhance";
import { structurePrompt } from "../shared/enhance";

describe("read-only project prompt environment", () => {
  let directory: string, projects: ProjectDirectory, paseo: PaseoApi;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "notes-probe-")); projects = new ProjectDirectory();
    paseo = { projects: { list: async () => ({ projects: [{ projectId: "project", projectRootPath: directory }] }), subscribe: () => () => {} } } as unknown as PaseoApi;
  });
  afterEach(async () => { projects.stop(); await rm(directory, { recursive: true, force: true }); });
  it("derives language and test invocation without copying or executing package scripts", async () => {
    const contents = JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "echo PRIVATE_TEXT; exit 1" } });
    await writeFile(join(directory, "package.json"), contents); await writeFile(join(directory, "tsconfig.json"), "{}");
    expect(await probeProject("project", paseo, projects)).toEqual({ languages: ["TypeScript"], testCommands: ["pnpm run test"], notices: [] });
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(contents);
  });
  it("recognizes Python, Rust and Go test conventions", async () => {
    await writeFile(join(directory, "pyproject.toml"), "[tool.pytest.ini_options]\ntestpaths = ['tests']");
    await writeFile(join(directory, "Cargo.toml"), "[package]\nname = 'demo'");
    await writeFile(join(directory, "go.mod"), "module example.test/demo");
    expect(await probeProject("project", paseo, projects)).toEqual({ languages: ["Python", "Rust", "Go"], testCommands: ["python -m pytest", "cargo test", "go test ./..."], notices: [] });
  });
  it("skips links and oversized manifests, returns placeholders for inbox and rejects arbitrary paths", async () => {
    await writeFile(join(directory, "external.json"), '{"scripts":{"test":"test"}}');
    await symlink(join(directory, "external.json"), join(directory, "package.json"));
    await writeFile(join(directory, "Cargo.toml"), "x".repeat(128 * 1024 + 1));
    expect((await probeProject("project", paseo, projects)).languages).toEqual([]);
    expect((await probeProject("__inbox__", paseo, projects)).notices[0]).toContain("没有项目目录");
    await expect(probeProject(directory, paseo, projects)).rejects.toThrow("重新选择");
  });
  it("handles malformed package data without inventing commands", async () => {
    await writeFile(join(directory, "package.json"), "{bad");
    const result = await probeProject("project", paseo, projects);
    expect(result.testCommands).toEqual([]); expect(result.notices.join(" ")).toContain("无法解析");
  });
  it("recognizes a large lockfile without reading its contents", async () => {
    await writeFile(join(directory, "package.json"), '{"scripts":{"test":"test"}}');
    await writeFile(join(directory, "pnpm-lock.yaml"), "x".repeat(256 * 1024));
    expect((await probeProject("project", paseo, projects)).testCommands).toEqual(["pnpm run test"]);
  });
});

describe("four-section prompt template", () => {
  const environment = { languages: ["TypeScript"], testCommands: ["npm run test"], notices: [] };
  it("keeps the draft verbatim, adds four sections and only observed test commands", () => {
    const body = "修复 `a$b`\n保持 {{已有变量}}";
    const result = structurePrompt("修复", body, environment);
    expect(result).toContain(body); expect(result.match(/^## /gm)).toHaveLength(4);
    expect(result).toContain("TypeScript"); expect(result).toContain("npm run test");
    expect(structurePrompt("修复", result, environment)).toBe(result);
  });
  it("preserves existing sections and does not truncate an oversized draft", () => {
    const body = "## 目标\n已有目标\n\n## 验收\n现有验收标准";
    const result = structurePrompt("", body, environment);
    expect(result.startsWith(body)).toBe(true); expect(result).not.toContain("npm run test");
    expect(() => structurePrompt("", "x".repeat(32000), environment)).toThrow("正文上限");
    expect(structurePrompt("新任务", "", { languages: [], testCommands: [], notices: [] })).toContain("{{测试命令}}");
  });
  it("does not mistake a heading inside a code example for the actual goal", () => {
    const body = "保留示例：\n```markdown\n## 目标\n示例内容\n```";
    expect(structurePrompt("", body, environment)).toMatch(/^## 目标\n保留示例/);
  });
});
