/**
 * 拾页命令行入口：让 Agent / 脚本不经过界面就能读写项目手记。
 *
 * 通过 esbuild 打包为 bin/notes.mjs（npm run build）。与插件子进程共用同一套 BoardStore
 * 与数据文件，写入受跨进程锁保护；前台打开的界面约每 5 秒（空闲一分钟后每 15 秒）按内容版本号检查，
 * 只取回变化的看板，会自动看到新记录。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  INBOX_PROJECT_ID, fieldsSchema, kindSchema, statusSchema,
  type BoardItem, type BoardProject, type NoteFields, type WriteBoardInput,
} from "../shared/schema";
import { BoardStore, defaultStorageRoot, paseoHome } from "./store";

export class CliError extends Error { constructor(message: string, readonly exitCode = 2) { super(message); } }

export interface CliDeps {
  store: BoardStore;
  /** Paseo 项目列表（不含随手记）。 */
  loadProjects: () => Promise<BoardProject[]>;
  stdout: (text: string) => void;
  readStdin: () => Promise<string>;
  cwd: string;
  env: Record<string, string | undefined>;
}

const INBOX: BoardProject = { id: INBOX_PROJECT_ID, name: "随手记", path: "" };
const VALUE_OPTIONS = new Set(["project", "kind", "status", "title", "body", "body-file", "priority", "request-id", "limit"]);
const FLAG_OPTIONS = new Set(["json", "pinned", "no-pinned", "all", "trash", "help", "high", "normal"]);

export interface ParsedArgs { command: string; positionals: string[]; values: Map<string, string>; flags: Set<string> }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []; const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const eq = arg.indexOf("="); const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (FLAG_OPTIONS.has(key)) { if (eq >= 0) throw new CliError(`--${key} 不接受值。`); flags.add(key); continue; }
    if (!VALUE_OPTIONS.has(key)) throw new CliError(`未知选项 --${key}。运行 --help 查看用法。`);
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else { value = argv[i + 1]; if (value === undefined || (value.startsWith("--") && value !== "-")) throw new CliError(`--${key} 需要一个值。`); i++; }
    values.set(key, value);
  }
  const [command = "help", ...rest] = positionals;
  return { command, positionals: rest, values, flags };
}

/** 项目引用：inbox / prj_… / 绝对路径 / 名称（精确或唯一子串）。省略时按当前目录归属。 */
export function resolveProject(ref: string | undefined, projects: readonly BoardProject[], cwd: string): BoardProject {
  const byPath = (target: string): BoardProject | null => {
    const resolved = path.resolve(target);
    let best: BoardProject | null = null;
    for (const project of projects) {
      if (!project.path) continue;
      const root = path.resolve(project.path);
      if (resolved === root || resolved.startsWith(root + path.sep)) if (!best || root.length > path.resolve(best.path).length) best = project;
    }
    return best;
  };
  if (ref === undefined || ref.trim() === "") {
    const found = byPath(cwd);
    if (found) return found;
    throw new CliError(`当前目录 ${cwd} 不属于任何 Paseo 项目。请用 --project 指定（inbox、项目 ID、路径或名称），运行 projects 查看可选项。`);
  }
  const wanted = ref.trim();
  if (wanted === "inbox" || wanted === INBOX.name || wanted === INBOX_PROJECT_ID) return INBOX;
  const byId = projects.find(p => p.id === wanted); if (byId) return byId;
  if (path.isAbsolute(wanted)) { const found = byPath(wanted); if (found) return found; throw new CliError(`路径 ${wanted} 不属于任何 Paseo 项目。`); }
  const lower = wanted.toLowerCase();
  const exact = projects.filter(p => p.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new CliError(`名称「${wanted}」对应多个项目，请改用项目 ID：${exact.map(p => `${p.id} (${p.path})`).join("、")}`);
  const partial = projects.filter(p => p.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new CliError(`名称「${wanted}」匹配多个项目：${partial.map(p => p.name).join("、")}。请写完整名称或项目 ID。`);
  throw new CliError(`找不到项目「${wanted}」。可用项目：inbox、${projects.map(p => p.name).join("、") || "（无）"}`);
}

export const USAGE = `拾页 · 项目手记 命令行

用法：node bin/notes.mjs <命令> [选项]

命令：
  projects                       列出可归属的项目（含 inbox 随手记）
  list [--project <ref>] [--kind task|prompt|idea] [--status todo|doing|done] [--all] [--trash] [--limit N]
                                 列出手记；默认排除已完成任务与回收站，--all 包含已完成
  add --title <标题> [--project <ref>] [--kind task|prompt|idea] [--body <正文> | --body-file <路径|->]
      [--status todo|doing|done] [--high] [--pinned] [--request-id <id>]
                                 新增一条；省略 --project 时按当前目录（或 PASEO_AGENT_CWD）归属
  show <itemId>                  显示一条完整内容
  update <itemId> [--title] [--body|--body-file] [--kind] [--status] [--high|--normal] [--pinned|--no-pinned]
  done <itemId>                  标记任务完成
  delete <itemId> / restore <itemId>
                                 移入 / 移出回收站

通用：--json 机器可读输出；--project 接受 inbox、prj_… ID、绝对路径或项目名称。
数据目录：$PASEO_HOME/plugin-data/project-notes/boards（与插件界面同一份文件）。

示例：
  node bin/notes.mjs add --project inbox --title "待整理的任务" --body-file - <<'EOF'
  ...多行设计说明...
  EOF
  node bin/notes.mjs list --project inbox --kind task
  node bin/notes.mjs done 3f1c…
`;

function formatItem(item: BoardItem, projectName: string): string {
  const marks = `${item.pinned ? "📌" : " "}${item.priority === "high" ? "!" : " "}`;
  const status = item.kind === "task" ? item.status.padEnd(5) : "     ";
  const trash = item.deletedAt ? " [回收站]" : "";
  return `${item.kind.padEnd(6)} ${status} ${marks} ${item.id}  ${item.title}  · ${projectName}${trash}  (rev ${item.revision}, ${item.updatedAt.slice(0, 16).replace("T", " ")})`;
}

function sortItems(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

async function readBody(args: ParsedArgs, deps: CliDeps): Promise<string | undefined> {
  if (args.values.has("body") && args.values.has("body-file")) throw new CliError("--body 与 --body-file 只能选一个。");
  if (args.values.has("body")) return args.values.get("body")!;
  const file = args.values.get("body-file");
  if (file === undefined) return undefined;
  if (file === "-") return deps.readStdin();
  return readFile(path.resolve(deps.cwd, file), "utf8");
}

async function projectsWithInbox(deps: CliDeps): Promise<BoardProject[]> { return [INBOX, ...(await deps.loadProjects())]; }

async function locateItem(id: string, args: ParsedArgs, deps: CliDeps, projects: BoardProject[]): Promise<{ item: BoardItem; project: BoardProject }> {
  if (!z.string().uuid().safeParse(id).success) throw new CliError(`「${id}」不是有效的记录 ID。`);
  const nameOf = (projectId: string) => projects.find(p => p.id === projectId) ?? { id: projectId, name: `历史项目 · ${projectId.slice(-8)}`, path: "" };
  if (args.values.has("project")) {
    const project = resolveProject(args.values.get("project"), projects.filter(p => p.id !== INBOX_PROJECT_ID), deps.cwd);
    const item = (await deps.store.read(project.id)).items.find(x => x.id === id);
    if (!item) throw new CliError(`项目「${project.name}」里没有记录 ${id}。`);
    return { item, project };
  }
  for (const board of await deps.store.readAll()) {
    const item = board.items.find(x => x.id === id);
    if (item) return { item, project: nameOf(board.projectId) };
  }
  throw new CliError(`没有找到记录 ${id}。`);
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join(".") || "输入"}: ${issue.message}`).join("；");
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("json");
  const emit = (human: string, data: unknown) => deps.stdout(json ? JSON.stringify(data, null, 2) + "\n" : human.endsWith("\n") ? human : human + "\n");
  if (args.command === "help" || args.flags.has("help")) { deps.stdout(USAGE); return 0; }

  if (args.command === "projects") {
    const projects = await projectsWithInbox(deps);
    emit(projects.map(p => `${p.id}\t${p.name}\t${p.path || "（不归入具体项目）"}`).join("\n"), { projects });
    return 0;
  }

  if (args.command === "list") {
    const projects = await projectsWithInbox(deps);
    const nameOf = (projectId: string) => projects.find(p => p.id === projectId)?.name ?? `历史项目 · ${projectId.slice(-8)}`;
    const boards = args.values.has("project")
      ? [await deps.store.read(resolveProject(args.values.get("project"), projects.filter(p => p.id !== INBOX_PROJECT_ID), deps.cwd).id)]
      : await deps.store.readAll();
    const kind = args.values.has("kind") ? kindSchema.parse(args.values.get("kind")) : undefined;
    const status = args.values.has("status") ? statusSchema.parse(args.values.get("status")) : undefined;
    const trash = args.flags.has("trash"); const all = args.flags.has("all");
    let items = sortItems(boards.flatMap(b => b.items)).filter(item => trash ? item.deletedAt !== null : item.deletedAt === null)
      .filter(item => !kind || item.kind === kind).filter(item => !status || item.status === status)
      .filter(item => all || trash || status || item.kind !== "task" || item.status !== "done");
    const limit = args.values.has("limit") ? z.coerce.number().int().positive().parse(args.values.get("limit")) : undefined;
    const total = items.length; if (limit) items = items.slice(0, limit);
    const lines = items.map(item => formatItem(item, nameOf(item.projectId)));
    if (limit && total > items.length) lines.push(`… 共 ${total} 条，仅显示前 ${items.length} 条`);
    emit(lines.join("\n") || "（没有匹配的手记）", { total, items: items.map(item => ({ ...item, projectName: nameOf(item.projectId) })) });
    return 0;
  }

  if (args.command === "add") {
    const projects = await deps.loadProjects();
    const project = resolveProject(args.values.get("project"), projects, deps.env.PASEO_AGENT_CWD ?? deps.cwd);
    if (!args.values.has("title")) throw new CliError("add 需要 --title。");
    const fields: NoteFields = fieldsSchema.parse({
      kind: args.values.get("kind") ?? "task",
      title: args.values.get("title"),
      body: (await readBody(args, deps)) ?? "",
      status: args.values.get("status") ?? "todo",
      priority: args.flags.has("high") ? "high" : args.values.get("priority") ?? "normal",
      pinned: args.flags.has("pinned"),
    });
    const requestId = args.values.get("request-id") ?? `cli-${randomUUID()}`;
    const result = await deps.store.write({ projectId: project.id, requestId, operation: { type: "create", fields } });
    emit(`${result.replayed ? "已存在（幂等重放）" : "已记录"} ${fields.kind}「${fields.title}」→ 项目「${project.name}」\nid=${result.itemId}`,
      { itemId: result.itemId, replayed: result.replayed, projectId: project.id, projectName: project.name, requestId });
    return 0;
  }

  if (["show", "update", "done", "delete", "restore"].includes(args.command)) {
    const id = args.positionals[0]; if (!id) throw new CliError(`${args.command} 需要记录 ID。`);
    const projects = await projectsWithInbox(deps);
    const { item, project } = await locateItem(id, args, deps, projects);
    if (args.command === "show") {
      emit(`${formatItem(item, project.name)}\n${item.body ? "\n" + item.body : "（无正文）"}`, { ...item, projectName: project.name });
      return 0;
    }
    const requestId = args.values.get("request-id") ?? `cli-${randomUUID()}`;
    let operation: WriteBoardInput["operation"];
    if (args.command === "delete") operation = { type: "delete", id, expectedRevision: item.revision };
    else if (args.command === "restore") operation = { type: "restore", id, expectedRevision: item.revision };
    else {
      const partial: Partial<NoteFields> = {};
      if (args.command === "done") partial.status = "done";
      if (args.values.has("title")) partial.title = args.values.get("title");
      const body = await readBody(args, deps); if (body !== undefined) partial.body = body;
      if (args.values.has("kind")) partial.kind = kindSchema.parse(args.values.get("kind"));
      if (args.values.has("status")) partial.status = statusSchema.parse(args.values.get("status"));
      if (args.flags.has("high")) partial.priority = "high"; else if (args.flags.has("normal")) partial.priority = "normal";
      else if (args.values.has("priority")) partial.priority = z.enum(["normal", "high"]).parse(args.values.get("priority"));
      if (args.flags.has("pinned")) partial.pinned = true; else if (args.flags.has("no-pinned")) partial.pinned = false;
      if (Object.keys(partial).length === 0) throw new CliError("update 至少需要一个要修改的字段。");
      operation = { type: "update", id, expectedRevision: item.revision, fields: fieldsSchema.partial().parse(partial) };
    }
    const result = await deps.store.write({ projectId: item.projectId, requestId, operation });
    const updated = result.board.items.find(x => x.id === id)!;
    emit(`${result.replayed ? "已执行过（幂等重放）" : "已更新"} ${formatItem(updated, project.name)}`, { ...updated, projectName: project.name, replayed: result.replayed, requestId });
    return 0;
  }

  throw new CliError(`未知命令「${args.command}」。\n\n${USAGE}`);
}

/** 真实项目列表：优先 paseo CLI，失败时读 daemon 的 projects.json。 */
export async function loadPaseoProjects(env: Record<string, string | undefined>): Promise<BoardProject[]> {
  const errors: string[] = [];
  try {
    const { stdout } = await promisify(execFile)("paseo", ["project", "ls", "--json"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    const rows = z.array(z.object({ projectId: z.string(), name: z.string(), path: z.string() })).parse(JSON.parse(stdout));
    return rows.map(row => ({ id: row.projectId, name: row.name, path: row.path }));
  } catch (e) { errors.push(`paseo project ls: ${(e as Error).message}`); }
  try {
    const raw = await readFile(path.join(paseoHome(env), "projects", "projects.json"), "utf8");
    const rows = z.array(z.object({ projectId: z.string(), rootPath: z.string(), displayName: z.string(), customName: z.string().nullable().optional(), archivedAt: z.string().nullable().optional() })).parse(JSON.parse(raw));
    return rows.filter(row => !row.archivedAt).map(row => ({ id: row.projectId, name: row.customName ?? row.displayName, path: row.rootPath }));
  } catch (e) { errors.push(`projects.json: ${(e as Error).message}`); }
  throw new CliError(`无法读取 Paseo 项目列表：${errors.join("；")}`);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const deps: CliDeps = {
    store: new BoardStore(defaultStorageRoot()),
    loadProjects: () => loadPaseoProjects(process.env),
    stdout: text => process.stdout.write(text),
    readStdin: readAllStdin,
    cwd: process.cwd(),
    env: process.env,
  };
  try { process.exitCode = await runCli(argv, deps); }
  catch (error) {
    if (error instanceof CliError) { process.stderr.write(error.message + "\n"); process.exitCode = error.exitCode; }
    else if (error instanceof z.ZodError) { process.stderr.write(`参数不合法：${describeZodError(error)}\n`); process.exitCode = 2; }
    else { process.stderr.write(`${(error as Error).message ?? String(error)}\n`); process.exitCode = 1; }
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false; } catch { return false; }
})();
if (invokedDirectly) void main();
