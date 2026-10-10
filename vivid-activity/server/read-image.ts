import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  MAX_READ_IMAGE_BYTES,
  detectImageMimeType,
  type ReadImageResult,
} from "../shared/read-image.js";

type ReadImageInput = { filePath: string; agentId?: string };

/** Resolves a read detail path against the agent cwd. Returns null when unresolvable. */
export function resolveAbsolutePath(
  filePath: string,
  agentCwd: string | null | undefined,
): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return trimmed;
  if (!agentCwd) return null;
  return resolve(agentCwd, trimmed);
}

/** True when `target` is `root` itself or below it (both absolute; `..` segments are resolved first). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The system temp directories every agent may write screenshots to. */
export function defaultTempRoots(): string[] {
  return [...new Set([tmpdir(), "/tmp"])];
}

/**
 * 本地补丁：图片预览只读 Agent 工作目录和临时目录里的文件。上游会读取任意绝对路径的图片，
 * 任何能调用插件 RPC 的客户端都能借它读出主机上的图片。符号链接按真实路径判断。
 */
export async function imageRoots(agentCwd: string | null, tempRoots: readonly string[]): Promise<{ lexical: string[]; real: string[] }> {
  const lexical = [agentCwd, ...tempRoots].filter((root): root is string => Boolean(root) && isAbsolute(root!)).map((root) => resolve(root));
  const real = await Promise.all(lexical.map((root) => realpath(root).catch(() => null)));
  return {
    lexical: [...new Set(lexical)],
    real: [...new Set(real.filter((root): root is string => root !== null))],
  };
}

async function resolveAgentCwd(
  paseo: PluginHandlerContext["paseo"],
  agentId: string | undefined,
): Promise<string | null> {
  if (!agentId) return null;
  try {
    const ref = paseo.agents.ref(agentId);
    await ref.refresh();
    return ref.cwd;
  } catch {
    return null;
  }
}

export async function handleReadImage(
  input: ReadImageInput,
  context: PluginHandlerContext,
  tempRoots: readonly string[] = defaultTempRoots(),
): Promise<ReadImageResult> {
  const agentCwd = await resolveAgentCwd(context.paseo, input.agentId);
  const absolutePath = resolveAbsolutePath(input.filePath, agentCwd);
  if (!absolutePath) return { status: "unavailable" };

  const roots = await imageRoots(agentCwd, tempRoots);
  // Refuse before touching the file system, so outside paths do not reveal whether they exist.
  if (![...roots.lexical, ...roots.real].some((root) => isInside(root, absolutePath))) return { status: "outside" };
  let realPath: string;
  try {
    realPath = await realpath(absolutePath);
  } catch {
    return { status: "not-found" };
  }
  if (!roots.real.some((root) => isInside(root, realPath))) return { status: "outside" };

  // Only regular files: opening a FIFO or device would block or stream forever.
  try {
    const fileStat = await stat(realPath);
    if (!fileStat.isFile()) return { status: "not-found" };
    if (fileStat.size > MAX_READ_IMAGE_BYTES) return { status: "too-large", byteSize: fileStat.size };
  } catch {
    return { status: "not-found" };
  }
  // One handle for the final check and the read; O_NOFOLLOW / O_NONBLOCK refuse a last component swapped
  // for a link or a FIFO after the checks above.
  let handle: FileHandle;
  try {
    handle = await open(realPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { status: "not-found" };
  }
  let bytes: Buffer;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return { status: "not-found" };
    if (fileStat.size > MAX_READ_IMAGE_BYTES) return { status: "too-large", byteSize: fileStat.size };
    if (fileStat.size === 0) return { status: "not-image", byteSize: 0 };
    bytes = await handle.readFile();
  } catch {
    return { status: "not-found" };
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.byteLength > MAX_READ_IMAGE_BYTES) return { status: "too-large", byteSize: bytes.byteLength };

  const mimeType = detectImageMimeType(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!mimeType) return { status: "not-image", byteSize: bytes.byteLength };
  return { status: "ok", data: bytes.toString("base64"), mimeType, byteSize: bytes.byteLength };
}
