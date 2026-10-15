/**
 * 拾页命令行入口：让 Agent / 脚本不经过界面就能读写项目手记。
 *
 * 通过 esbuild 打包为 bin/notes.mjs（npm run build）。与插件子进程共用同一套 BoardStore
 * 与数据文件，写入受跨进程锁保护；前台打开的界面约每 5 秒（空闲一分钟后每 15 秒）按内容版本号检查，
 * 只取回变化的看板，会自动看到新记录。
 *
 * 读取的输入都有上限：--body-file 只读普通文件，先按 stat 的大小拒绝过大的文件再读；stdin 读到上限即停。
 * 不限制路径：命令行由 Agent 在自己的 shell 里运行，它本来就能读这些文件，路径白名单挡不住任何东西。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  BOARD_FILE_LIMIT_BYTES, BODY_MAX_LENGTH, getInboxDescription, INBOX_PROJECT_ID, OVERVIEW_LIMIT_BYTES, fieldsSchema, kindSchema, statusSchema,
  type BoardItem, type BoardProject, type NoteFields, type WriteBoardInput,
} from "../shared/schema";
import { BoardStore, defaultStorageRoot, paseoHome } from "./store";
import { t } from "../shared/text";
import { assembleCatalog, bindTranslator, checkCatalog, createTranslator, joinList, normalizeLanguage, resolveLanguage, type Catalog } from "../shared/i18n";
import { BUILTIN_CATALOGS } from "./locales";

export class CliError extends Error { constructor(message: string, readonly exitCode = 2) { super(message); } }

export interface CliDeps {
  store: BoardStore;
  /** Paseo 项目列表（不含随手记）。 */
  loadProjects: () => Promise<BoardProject[]>;
  /** Paseo 的持久工作区归属；命令行无需连接 daemon。 */
  loadWorkspaces?: () => Promise<BoardWorkspace[]>;
  stdout: (text: string) => void;
  /** Standard input as text, refused once it passes `maxBytes`. */
  readStdin: (maxBytes: number) => Promise<string>;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface BoardWorkspace { projectId: string; cwd: string }

const inbox = (): BoardProject => ({ id: INBOX_PROJECT_ID, name: t("serverStore.inbox"), path: "" });
/** UTF-8 takes at most 3 bytes per UTF-16 unit, so a larger body file or stdin can never pass the body limit. */
const MAX_BODY_BYTES = BODY_MAX_LENGTH * 3;
/** The same bound as the `paseo project ls` output that projects.json stands in for. */
const MAX_PROJECTS_BYTES = 8 * 1024 * 1024;
const VALUE_OPTIONS = new Set(["project", "kind", "status", "title", "body", "body-file", "priority", "request-id", "limit"]);
const FLAG_OPTIONS = new Set(["json", "pinned", "no-pinned", "all", "trash", "help", "high", "normal", "history"]);

export interface ParsedArgs { command: string; positionals: string[]; values: Map<string, string>; flags: Set<string> }

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []; const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const eq = arg.indexOf("="); const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (FLAG_OPTIONS.has(key)) { if (eq >= 0) throw new CliError(t("cli.flagNoValue", { key })); flags.add(key); continue; }
    if (!VALUE_OPTIONS.has(key)) throw new CliError(t("cli.unknownOption", { key }));
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else { value = argv[i + 1]; if (value === undefined || (value.startsWith("--") && value !== "-")) throw new CliError(t("cli.optionNeedsValue", { key })); i++; }
    values.set(key, value);
  }
  const [command = "help", ...rest] = positionals;
  return { command, positionals: rest, values, flags };
}

/** 项目引用：inbox / prj_… / 绝对路径 / 名称（精确或唯一子串）。省略时按当前目录归属。 */
export function resolveProject(ref: string | undefined, projects: readonly BoardProject[], cwd: string, workspaces: readonly BoardWorkspace[] = []): BoardProject {
  const byPath = (target: string): BoardProject | null => {
    const resolved = path.resolve(target);
    const contains = (root: string) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    // Workspace ownership wins even when an external worktree sits below a different project's root.
    const matches = workspaces.filter(workspace => contains(path.resolve(workspace.cwd)))
      .sort((a, b) => path.resolve(b.cwd).length - path.resolve(a.cwd).length);
    const closest = matches[0];
    if (closest) {
      const equallyClose = matches.filter(workspace => path.resolve(workspace.cwd).length === path.resolve(closest.cwd).length);
      if (new Set(equallyClose.map(workspace => workspace.projectId)).size > 1) throw new CliError(t("cli.ambiguousWorkspace", { target }));
      const project = projects.find(project => project.id === closest.projectId);
      if (!project) throw new CliError(t("cli.workspaceProjectMissing", { target }));
      return project;
    }
    let best: BoardProject | null = null;
    for (const project of projects) {
      if (!project.path) continue;
      const root = path.resolve(project.path);
      if (contains(root)) if (!best || root.length > path.resolve(best.path).length) best = project;
    }
    return best;
  };
  if (ref === undefined || ref.trim() === "") {
    const found = byPath(cwd);
    if (found) return found;
    throw new CliError(t("cli.cwdNoProject", { cwd }));
  }
  const wanted = ref.trim();
  // i18n-ignore: the original Chinese CLI alias remains accepted as input for existing scripts.
  if (wanted === "inbox" || wanted === "随手记" || wanted === INBOX_PROJECT_ID) return inbox();
  const byId = projects.find(p => p.id === wanted); if (byId) return byId;
  if (path.isAbsolute(wanted)) { const found = byPath(wanted); if (found) return found; throw new CliError(t("cli.pathNoProject", { wanted })); }
  const lower = wanted.toLowerCase();
  const exact = projects.filter(p => p.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new CliError(t("cli.duplicateProjectName", { wanted, projects: joinList(exact.map(p => t("cli.projectReference", { id: p.id, path: p.path }))) }));
  const partial = projects.filter(p => p.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new CliError(t("cli.ambiguousProjectName", { wanted, projects: joinList(partial.map(p => p.name)) }));
  throw new CliError(t("cli.projectNotFound", { wanted, projects: joinList(["inbox", joinList(projects.map(p => p.name)) || t("cli.none")]) }));
}

async function resolveCliProject(ref: string | undefined, projects: readonly BoardProject[], deps: CliDeps, cwd = deps.cwd): Promise<BoardProject> {
  if (ref?.trim() && !path.isAbsolute(ref.trim())) return resolveProject(ref, projects, cwd);
  const workspaces = await deps.loadWorkspaces?.() ?? [];
  const paths = new Map<string, Promise<string>>();
  const canonical = (value: string) => {
    if (!paths.has(value)) paths.set(value, realpath(value).catch(() => path.resolve(value)));
    return paths.get(value)!;
  };
  const [target, canonicalProjects, canonicalWorkspaces] = await Promise.all([
    canonical(ref?.trim() || cwd),
    Promise.all(projects.map(async project => ({ ...project, path: project.path ? await canonical(project.path) : "" }))),
    Promise.all(workspaces.map(async workspace => ({ ...workspace, cwd: await canonical(workspace.cwd) }))),
  ]);
  const project = resolveProject(undefined, canonicalProjects, target, canonicalWorkspaces);
  return projects.find(candidate => candidate.id === project.id)!;
}

export const usage = () => t("cli.usage");

/**
 * Human-readable output escapes control characters that come from notes, project names or paths: ESC sequences could
 * clear the screen, rewrite earlier lines or set the clipboard (OSC 52), CR and backspace overwrite what was printed.
 * Newlines and tabs stay, and CRLF line ends read as newlines. `--json` output is unchanged.
 */
export function terminalSafe(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Times print in UTC and say so: the CLI runs in agent shells whose time zone says nothing about the reader's. */
function formatTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? t("cli.utcTime", { time: new Date(time).toISOString().slice(0, 16).replace("T", " ") }) : value;
}

const kindLabel = (kind: NoteFields["kind"]) => ({ task: t("cli.kindTask"), prompt: t("cli.kindPrompt"), idea: t("cli.kindIdea") })[kind];
const statusLabel = (status: NoteFields["status"]) => ({ todo: t("cli.statusTodo"), doing: t("cli.statusDoing"), done: t("cli.statusDone") })[status];

function formatItem(item: BoardItem, projectName: string): string {
  const marks = `${item.pinned ? "📌" : " "}${item.priority === "high" ? "!" : " "}`;
  const status = item.kind === "task" ? statusLabel(item.status).padEnd(5) : "     ";
  const trash = item.deletedAt ? t("cli.trash") : "";
  return t("cli.item", { kind: kindLabel(item.kind).padEnd(6), status, marks, id: item.id, title: item.title, project: projectName, trash, revision: item.revision, time: formatTime(item.updatedAt) });
}

function sortItems(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Reads a stream as UTF-8 text and stops as soon as it passes `maxBytes`. */
export async function readLimited(chunks: AsyncIterable<Buffer | string>, maxBytes: number, label: string): Promise<string> {
  const buffers: Buffer[] = []; let total = 0;
  for await (const chunk of chunks) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > maxBytes) throw new CliError(t("cli.streamTooLarge", { label, maxBytes }));
    buffers.push(buffer);
  }
  return Buffer.concat(buffers).toString("utf8");
}
async function* fileChunks(handle: FileHandle): AsyncGenerator<Buffer> {
  for (;;) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
  }
}
/**
 * Reads a regular file of at most `maxBytes`. Directories, devices and FIFOs are refused from `stat`, before anything
 * opens them (opening a FIFO would block, /dev/zero never ends), and a file that grows meanwhile stops at the limit.
 */
async function readFileLimited(file: string, maxBytes: number, label: string, hint = ""): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw new CliError(t("cli.notRegularFile", { label, file, hint }));
  if (info.size > maxBytes) throw new CliError(t("cli.fileTooLarge", { label, file, bytes: info.size, maxBytes }));
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new CliError(t("cli.notRegularFile", { label, file, hint }));
    return await readLimited(fileChunks(handle), maxBytes, `${label.trim()} ${file} `);
  } finally { await handle.close(); }
}

async function readBody(args: ParsedArgs, deps: CliDeps): Promise<string | undefined> {
  if (args.values.has("body") && args.values.has("body-file")) throw new CliError(t("cli.bodyOptionsExclusive"));
  if (args.values.has("body")) return args.values.get("body")!;
  const file = args.values.get("body-file");
  if (file === undefined) return undefined;
  if (file === "-" || file === "/dev/stdin") return deps.readStdin(MAX_BODY_BYTES);
  return readFileLimited(path.resolve(deps.cwd, file), MAX_BODY_BYTES, t("cli.bodyFile"), t("cli.stdinHint"));
}

const megabytes = (bytes: number) => t("cli.megabytes", { count: Math.round(bytes / (1024 * 1024)) });
/** Readable boards plus, by project, the ones left out of the overview for their size (a single board still reads with --project). */
async function readEveryBoard(deps: CliDeps, projects: readonly BoardProject[]) {
  const { entries, unavailable } = await deps.store.readEntries();
  const byFile = new Map(projects.map(project => [deps.store.boardFile(project.id), project.id]));
  return {
    boards: entries.map(entry => entry.snapshot),
    unavailable: unavailable.map(board => ({ projectId: board.projectId ?? byFile.get(board.file) ?? null, bytes: board.bytes, reason: board.reason })),
  };
}
type Unavailable = Awaited<ReturnType<typeof readEveryBoard>>["unavailable"];
function describeUnavailable(unavailable: Unavailable, nameOf: (projectId: string) => string): string {
  const each = unavailable.map(board => {
    const who = board.projectId ? t("cli.projectQuoted", { name: nameOf(board.projectId) }) : t("cli.removedProject");
    return board.reason === "file" ? t("cli.unavailableFile", { project: who, size: megabytes(board.bytes), limit: megabytes(BOARD_FILE_LIMIT_BYTES) })
      : t("cli.unavailableTotal", { project: who, size: megabytes(board.bytes), limit: megabytes(OVERVIEW_LIMIT_BYTES) });
  });
  return t("cli.unavailableBoards", { count: unavailable.length, projects: joinList(each) });
}

async function projectsWithInbox(deps: CliDeps): Promise<BoardProject[]> { return [inbox(), ...(await deps.loadProjects())]; }

async function locateItem(id: string, args: ParsedArgs, deps: CliDeps, projects: BoardProject[]): Promise<{ item: BoardItem; project: BoardProject }> {
  if (!z.string().uuid().safeParse(id).success) throw new CliError(t("cli.invalidNoteId", { id }));
  const nameOf = (projectId: string) => projects.find(p => p.id === projectId) ?? { id: projectId, name: t("serverStore.historicalProject", { id: projectId.slice(-8) }), path: "" };
  if (args.values.has("project")) {
    const project = await resolveCliProject(args.values.get("project"), projects.filter(p => p.id !== INBOX_PROJECT_ID), deps);
    const item = (await deps.store.read(project.id)).items.find(x => x.id === id);
    if (!item) throw new CliError(t("cli.noteMissingInProject", { project: project.name, id }));
    return { item, project };
  }
  const { boards, unavailable } = await readEveryBoard(deps, projects);
  for (const board of boards) {
    const item = board.items.find(x => x.id === id);
    if (item) return { item, project: nameOf(board.projectId) };
  }
  throw new CliError(t("cli.noteNotFound", { id, hint: unavailable.length ? t("cli.noteInUnavailable", { details: describeUnavailable(unavailable, projectId => nameOf(projectId).name) }) : "" }));
}

function describeZodError(error: z.ZodError): string {
  return error.issues.map(issue => t("cli.validationIssue", { field: issue.path.join(".") || t("cli.input"), message: issue.message })).join(t("cli.errorSeparator"));
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("json");
  const emit = (human: string, data: unknown) => deps.stdout(json ? JSON.stringify(data, null, 2) + "\n" : terminalSafe(human.endsWith("\n") ? human : human + "\n"));
  if (args.command === "help" || args.flags.has("help")) { deps.stdout(usage()); return 0; }

  if (args.command === "projects") {
    const projects = await projectsWithInbox(deps);
    emit(projects.map(p => `${p.id}\t${p.name}\t${p.path || t("cli.inboxPath", { description: getInboxDescription() })}`).join("\n"), { projects });
    return 0;
  }

  if (args.command === "list") {
    const projects = await projectsWithInbox(deps);
    const nameOf = (projectId: string) => projects.find(p => p.id === projectId)?.name ?? t("serverStore.historicalProject", { id: projectId.slice(-8) });
    const { boards, unavailable } = args.values.has("project")
      ? { boards: [await deps.store.read((await resolveCliProject(args.values.get("project"), projects.filter(p => p.id !== INBOX_PROJECT_ID), deps)).id)], unavailable: [] as Unavailable }
      : await readEveryBoard(deps, projects);
    const kind = args.values.has("kind") ? kindSchema.parse(args.values.get("kind")) : undefined;
    const status = args.values.has("status") ? statusSchema.parse(args.values.get("status")) : undefined;
    const trash = args.flags.has("trash"); const all = args.flags.has("all");
    let items = sortItems(boards.flatMap(b => b.items)).filter(item => trash ? item.deletedAt !== null : item.deletedAt === null)
      .filter(item => !kind || item.kind === kind).filter(item => !status || item.status === status)
      .filter(item => all || trash || status || item.kind !== "task" || item.status !== "done");
    const limit = args.values.has("limit") ? z.coerce.number().int().positive().parse(args.values.get("limit")) : undefined;
    const total = items.length; if (limit) items = items.slice(0, limit);
    const lines = items.map(item => formatItem(item, nameOf(item.projectId)));
    if (limit && total > items.length) lines.push(t("cli.limited", { total, count: items.length }));
    if (!lines.length) lines.push(t("cli.empty"));
    if (unavailable.length) lines.push(describeUnavailable(unavailable, nameOf));
    emit(lines.join("\n"), {
      total, items: items.map(item => ({ ...item, projectName: nameOf(item.projectId) })),
      ...(unavailable.length ? { unavailable: unavailable.map(board => ({ ...board, projectName: board.projectId ? nameOf(board.projectId) : null })) } : {}),
    });
    return 0;
  }

  if (args.command === "add") {
    const projects = await deps.loadProjects();
    const project = await resolveCliProject(args.values.get("project"), projects, deps, deps.env.PASEO_AGENT_CWD ?? deps.cwd);
    if (!args.values.has("title")) throw new CliError(t("cli.titleRequired"));
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
    emit(t(result.replayed ? "cli.createdReplay" : "cli.created", { kind: kindLabel(fields.kind), title: fields.title, project: project.name, id: result.itemId }),
      { itemId: result.itemId, replayed: result.replayed, projectId: project.id, projectName: project.name, requestId });
    return 0;
  }

  if (["show", "update", "done", "delete", "restore"].includes(args.command)) {
    const id = args.positionals[0]; if (!id) throw new CliError(t("cli.idRequired", { command: args.command }));
    const projects = await projectsWithInbox(deps);
    const { item, project } = await locateItem(id, args, deps, projects);
    if (args.command === "show") {
      const loaded = args.flags.has("history") ? await deps.store.readHistory(item.projectId, item.id) : undefined;
      const history = loaded?.versions;
      const warning = loaded?.missing ? t("cli.missingSnapshots", { count: loaded.missingCount }) : "";
      emit(`${formatItem(item, project.name)}\n${item.body ? "\n" + item.body : t("cli.noBody")}${history ? t("cli.snapshots", { snapshots: history.map(version => t("cli.snapshot", { revision: version.revision, title: version.title, body: version.body })).join("\n\n") }) : ""}${warning}`, { ...item, projectName: project.name, ...(loaded ? { history: loaded.versions, historyMissing: loaded.missing, historyMissingCount: loaded.missingCount } : {}) });
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
      if (Object.keys(partial).length === 0) throw new CliError(t("cli.updateFieldRequired"));
      operation = { type: "update", id, expectedRevision: item.revision, fields: fieldsSchema.partial().parse(partial) };
    }
    const result = await deps.store.write({ projectId: item.projectId, requestId, operation });
    const updated = result.board.items.find(x => x.id === id)!;
    emit(t(result.replayed ? "cli.updatedReplay" : "cli.updated", { item: formatItem(updated, project.name) }), { ...updated, projectName: project.name, replayed: result.replayed, requestId });
    return 0;
  }

  throw new CliError(t("cli.unknownCommand", { command: args.command, usage: usage() }));
}

/** 真实项目列表：优先 paseo CLI，失败时读 daemon 的 projects.json。 */
export async function loadPaseoProjects(env: Record<string, string | undefined>): Promise<BoardProject[]> {
  const errors: string[] = [];
  try {
    const { stdout } = await promisify(execFile)("paseo", ["project", "ls", "--json"], { env: env as NodeJS.ProcessEnv, timeout: 15_000, maxBuffer: MAX_PROJECTS_BYTES });
    const rows = z.array(z.object({ projectId: z.string(), name: z.string(), path: z.string() })).parse(JSON.parse(stdout));
    return rows.map(row => ({ id: row.projectId, name: row.name, path: row.path }));
  } catch (e) { errors.push(`paseo project ls: ${(e as Error).message}`); }
  try {
    const raw = await readFileLimited(path.join(paseoHome(env), "projects", "projects.json"), MAX_PROJECTS_BYTES, "projects.json ");
    const rows = z.array(z.object({ projectId: z.string(), rootPath: z.string(), displayName: z.string(), customName: z.string().nullable().optional(), archivedAt: z.string().nullable().optional() })).parse(JSON.parse(raw));
    return rows.filter(row => !row.archivedAt).map(row => ({ id: row.projectId, name: row.customName ?? row.displayName, path: row.rootPath }));
  } catch (e) { errors.push(`projects.json: ${(e as Error).message}`); }
  throw new CliError(t("cli.projectsReadFailed", { errors: errors.join(t("cli.errorSeparator")) }));
}


/** 0.11 workspace-registry: JSON 数组，cwd → projectId；CLI 的 workspace ls 行只有项目显示名。 */
export async function loadPaseoWorkspaces(env: Record<string, string | undefined>): Promise<BoardWorkspace[]> {
  try {
    const raw = await readFileLimited(path.join(paseoHome(env), "projects", "workspaces.json"), MAX_PROJECTS_BYTES, "workspaces.json ");
    const rows = z.array(z.object({
      workspaceId: z.string(), projectId: z.string(), cwd: z.string().refine(path.isAbsolute), archivedAt: z.string().nullable(),
    })).parse(JSON.parse(raw));
    return rows.filter(row => !row.archivedAt).map(({ projectId, cwd }) => ({ projectId, cwd }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CliError(t("cli.workspacesReadFailed", { error: (error as Error).message }));
  }
}

/** Read only bounded regular files, so a malformed locale never blocks a terminal command. */
async function localeJson(file: string, maxBytes: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total > maxBytes ? null : JSON.parse(buffer.toString("utf8", 0, total));
  } finally { await handle.close(); }
}

/** The standalone CLI follows the plugin's saved setting, then its most recent device language. */
export async function loadCliLanguage(env: Record<string, string | undefined>): Promise<string> {
  const base = path.join(paseoHome(env), "plugin-data", "project-notes");
  const builtins: Readonly<Record<string, readonly Catalog[]>> = BUILTIN_CATALOGS;
  const english = builtins.en!, chinese = builtins["zh-CN"]!;
  const reference = assembleCatalog([...english, ...chinese]);
  const state = await localeJson(path.join(base, "i18n-state.json"), 16 * 1024).catch(() => null);
  const saved = state && typeof state === "object" ? state as { setting?: unknown; device?: unknown } : {};
  const setting = typeof saved.setting === "string" && saved.setting.length <= 40 ? saved.setting : undefined;
  const device = normalizeLanguage(saved.device);
  const folder = path.join(base, "locales"), filePattern = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})\.json$/;
  const files = (await readdir(folder).catch(() => [])).filter(file => filePattern.test(file)).sort().slice(0, 40);
  const customs = new Map<string, Catalog>();
  for (const file of files) {
    const code = normalizeLanguage(filePattern.exec(file)![1]);
    if (!code || customs.has(code)) continue;
    const raw = await localeJson(path.join(folder, file), 2 * 1024 * 1024).catch(() => null);
    const checked = checkCatalog(raw, reference);
    if (checked.translated > 0) customs.set(code, checked.catalog);
  }
  const language = resolveLanguage(setting, device, [...new Set([...Object.keys(builtins), ...customs.keys()])]);
  const custom = customs.get(language);
  const layers: Catalog[] = [], languages: string[] = [];
  const add = (from: string, catalogs: readonly Catalog[]) => { for (const catalog of catalogs) { layers.push(catalog); languages.push(from); } };
  if (custom) add(language, [custom]);
  add(language, builtins[language] ?? []);
  add("en", english);
  add("zh-CN", chinese);
  const catalog = assembleCatalog(layers, undefined, { language, languages });
  bindTranslator(createTranslator(language, [catalog]));
  return language;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await loadCliLanguage(process.env);
  const deps: CliDeps = {
    store: new BoardStore(defaultStorageRoot()),
    loadProjects: () => loadPaseoProjects(process.env),
    loadWorkspaces: () => loadPaseoWorkspaces(process.env),
    stdout: text => process.stdout.write(text),
    readStdin: maxBytes => readLimited(process.stdin, maxBytes, t("cli.stdin")),
    cwd: process.cwd(),
    env: process.env,
  };
  // Error messages quote project names, paths and arguments: escaped like the rest of the human-readable output.
  const fail = (message: string, code: number) => { process.stderr.write(terminalSafe(message) + "\n"); process.exitCode = code; };
  try { process.exitCode = await runCli(argv, deps); }
  catch (error) {
    if (error instanceof CliError) fail(error.message, error.exitCode);
    else if (error instanceof z.ZodError) fail(t("cli.invalidArguments", { error: describeZodError(error) }), 2);
    else fail((error as Error).message ?? String(error), 1);
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false; } catch { return false; }
})();
if (invokedDirectly) void main();
