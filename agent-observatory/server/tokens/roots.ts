import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { TokenSource } from "../../shared/tokens";
import type { LogRoot } from "./types";

/**
 * Where provider session logs live. The defaults cover Claude Code and Codex as installed; custom Paseo providers
 * that extend them (`extends: "claude" | "codex"`) can move their logs with `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, set
 * either in the provider's `env` or in its launcher script. Both are read here without running anything: the env
 * values are taken as written, and a launcher is read as text (at most 64 KB, no binaries) for literal assignments.
 * No other variable or value is ever read from provider env or launchers.
 */
export const MAX_ROOTS = 8;
const CONFIG_ENV: Record<TokenSource, "CLAUDE_CONFIG_DIR" | "CODEX_HOME"> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const LOG_FOLDER: Record<TokenSource, string> = { claude: "projects", codex: "sessions" };
const LAUNCHER_MAX_BYTES = 64 * 1024;
/** Interpreters in front of a launcher (`["/usr/bin/python3", "/opt/launch.py"]`): the script is the next argument. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|env|node|bun|deno|python[0-9.]*|perl|ruby)$/;

export interface RootContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Text of a small launcher file, or null (missing, too large, binary, unreadable). */
  readText?: (path: string) => Promise<string | null>;
}

/** The roots checked on every host: the daemon's own environment, then the standard locations. */
export function defaultRoots(context: Pick<RootContext, "home" | "env"> = { home: homedir(), env: process.env }): LogRoot[] {
  const { home, env } = context;
  const roots: LogRoot[] = [
    { source: "claude", path: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects") },
    { source: "claude", path: join(home, ".claude", "projects") },
    { source: "claude", path: join(home, ".config", "claude", "projects") },
    { source: "codex", path: join(env.CODEX_HOME || join(home, ".codex"), "sessions") },
  ];
  return roots.filter((root, index) => roots.findIndex(other => resolve(other.path) === resolve(root.path)) === index);
}

/** A literal absolute path: `~`, `$HOME` and `${HOME}` expand at the start; any other `$`, backtick or relative path is not literal. */
export function literalPath(value: string, home: string): string | null {
  let text = value.trim();
  if (text.length >= 2 && (text[0] === "\"" || text[0] === "'") && text.at(-1) === text[0]) text = text.slice(1, -1);
  if (text === "~" || text === "$HOME" || text === "${HOME}") return home;
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) if (text.startsWith(prefix)) { text = join(home, text.slice(prefix.length)); break; }
  if (!text || /[$`\n]/.test(text) || !isAbsolute(text)) return null;
  return resolve(text);
}

/** The built-in log format a provider writes: its own id, or the built-in it extends. */
export function providerSource(id: string, entry: { extends?: unknown }): TokenSource | null {
  const base = typeof entry.extends === "string" && entry.extends.trim() ? entry.extends.trim() : id;
  return base === "claude" || base === "codex" ? base : null;
}

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The last literal assignment of `name` in a launcher's text, as when it runs: `export NAME=…` / `NAME=…` (shell),
 * `"NAME": "…"` (a dict or object literal) and `["NAME"] = "…"` / `.NAME = "…"` (an environment update).
 */
export function launcherAssignment(text: string, name: string, home: string): string | null {
  const key = escapeName(name);
  const patterns = [
    new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}=("[^"\\n]*"|'[^'\\n]*'|[^\\s;&|#]+)`, "gm"),
    new RegExp(`["']${key}["'][ \\t]*:[ \\t]*("[^"\\n]*"|'[^'\\n]*')`, "g"),
    new RegExp(`(?:\\[[ \\t]*["']${key}["'][ \\t]*\\]|\\.${key})[ \\t]*=[ \\t]*("[^"\\n]*"|'[^'\\n]*')`, "g"),
  ];
  let found: { at: number; path: string } | null = null;
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const path = literalPath(match[1]!, home);
    if (path && (!found || match.index! >= found.at)) found = { at: match.index!, path };
  }
  return found?.path ?? null;
}

const commandParts = (command: unknown): string[] => Array.isArray(command) ? command.filter((part): part is string => typeof part === "string").slice(0, 8) : [];
/** The launcher file a provider command names: the command itself, or the script after an interpreter and its flags. */
export function launcherCandidates(command: unknown, home: string): string[] {
  const parts = commandParts(command);
  if (!parts.length) return [];
  if (!INTERPRETER.test(basename(parts[0]!))) { const path = literalPath(parts[0]!, home); return path ? [path] : []; }
  if (parts.includes("-c")) return [];
  for (const part of parts.slice(1)) {
    if (part.startsWith("-") || part.includes("=")) continue;
    const path = literalPath(part, home);
    return path ? [path] : [];
  }
  return [];
}
/** The script of `["bash", "-c", "export CLAUDE_CONFIG_DIR=…; exec claude"]`. */
export function inlineScript(command: unknown): string | null {
  const parts = commandParts(command), index = parts.indexOf("-c");
  return parts.length && INTERPRETER.test(basename(parts[0]!)) && index > 0 ? parts[index + 1] ?? null : null;
}

/** `["env", "CODEX_HOME=/x", "codex"]`: an assignment passed on the command line. */
function commandAssignment(command: unknown, name: string, home: string): string | null {
  let found: string | null = null;
  for (const part of commandParts(command)) if (part.startsWith(`${name}=`)) found = literalPath(part.slice(name.length + 1), home) ?? found;
  return found;
}

/** Bounded text read: regular files up to 64 KB with no NUL byte in them. */
export async function readLauncherText(path: string): Promise<string | null> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > LAUNCHER_MAX_BYTES) return null;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(details.size);
      const { bytesRead } = await handle.read(buffer, 0, details.size, 0);
      const content = buffer.subarray(0, bytesRead);
      return content.includes(0) ? null : content.toString("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
}

export interface DiscoveredRoot extends LogRoot { provider: string; via: "env" | "command" | "launcher" }

/**
 * Log roots of the daemon's custom providers that moved their config directory. Order: provider `env`, an
 * assignment on the command line, then the launcher's text. Providers that do not move it use the default roots.
 */
export async function providerRoots(providers: Readonly<Record<string, unknown>> | undefined, context: RootContext): Promise<DiscoveredRoot[]> {
  const found: DiscoveredRoot[] = [];
  const readText = context.readText ?? readLauncherText;
  for (const [id, raw] of Object.entries(providers ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { extends?: unknown; command?: unknown; env?: unknown };
    const source = providerSource(id, entry);
    if (!source) continue;
    const name = CONFIG_ENV[source];
    const env = entry.env && typeof entry.env === "object" ? (entry.env as Record<string, unknown>)[name] : undefined;
    let directory = typeof env === "string" ? literalPath(env, context.home) : null, via: DiscoveredRoot["via"] = "env";
    if (!directory) { directory = commandAssignment(entry.command, name, context.home); via = "command"; }
    if (!directory) { const script = inlineScript(entry.command); directory = script ? launcherAssignment(script, name, context.home) : null; }
    if (!directory) {
      via = "launcher";
      for (const path of launcherCandidates(entry.command, context.home)) {
        const text = await readText(path);
        directory = text ? launcherAssignment(text, name, context.home) : null;
        if (directory) break;
      }
    }
    if (directory) found.push({ source, path: join(directory, LOG_FOLDER[source]), provider: id, via });
  }
  return found;
}

/** Canonical form for comparing roots: the real path when it exists, else the resolved one. */
export async function rootIdentity(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}
