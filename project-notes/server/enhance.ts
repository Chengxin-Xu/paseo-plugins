import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { INBOX_PROJECT_ID } from "../shared/schema";
import type { ProjectEnvironment } from "../shared/enhance";
import type { ProjectDirectory } from "./dashboard";

const MAX_FILE_BYTES = 128 * 1024;
/** Fixed root-level manifests only. Do not follow links, open devices, run scripts or inspect source files. */
async function manifest(root: string, name: string): Promise<string | null> {
  let file;
  try {
    file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytesRead > MAX_FILE_BYTES ? null : bytes.toString("utf8", 0, bytesRead);
  } catch { return null; }
  finally { await file?.close(); }
}
async function hasLock(root: string, name: string) {
  try { return (await lstat(join(root, name))).isFile(); } catch { return false; }
}

export async function probeProject(projectId: string, paseo: PluginHandlerContext["paseo"], projects: ProjectDirectory): Promise<ProjectEnvironment> {
  if (projectId === INBOX_PROJECT_ID) return { languages: [], testCommands: [], notices: ["随手记没有项目目录，请填写范围和测试命令。"] };
  const project = (await projects.list(paseo)).find(value => value.projectId === projectId);
  if (!project) throw new Error("项目已移除，请重新选择项目。");
  const files = ["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  const [values, locks] = await Promise.all([
    Promise.all(files.map(name => manifest(project.projectRootPath, name))),
    Promise.all(["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map(name => hasLock(project.projectRootPath, name))),
  ]);
  const [pkg, ts, python, rust, go] = values, [pnpm, yarn, bun, bunBinary] = locks;
  const languages: string[] = [], testCommands: string[] = [], notices: string[] = [];
  if (pkg !== null) {
    languages.push(ts !== null ? "TypeScript" : "JavaScript");
    try {
      const parsed = JSON.parse(pkg!);
      if (parsed && typeof parsed.scripts?.test === "string" && parsed.scripts.test.trim()) {
        const manager = typeof parsed.packageManager === "string" ? parsed.packageManager.split("@")[0] : pnpm ? "pnpm" : yarn ? "yarn" : bun || bunBinary ? "bun" : "npm";
        testCommands.push(`${["npm", "pnpm", "yarn", "bun"].includes(manager) ? manager : "npm"} run test`);
      }
    } catch { notices.push("package.json 无法解析，未推断测试命令。"); }
  } else if (ts !== null) languages.push("TypeScript");
  if (python !== null) { languages.push("Python"); if (/^\s*\[tool\.pytest(?:\.|\])/m.test(python!)) testCommands.push("python -m pytest"); }
  if (rust !== null) { languages.push("Rust"); testCommands.push("cargo test"); }
  if (go !== null) { languages.push("Go"); testCommands.push("go test ./..."); }
  if (!testCommands.length) notices.push("未识别到测试命令，请填写并核对验收方式。");
  return { languages, testCommands, notices };
}
