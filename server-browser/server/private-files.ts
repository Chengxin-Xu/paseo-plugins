import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';

/**
 * Create a directory only the daemon user may use, or check an existing one: a real directory (not a symbolic link)
 * owned by the current user, then set to 0700. Anything else is refused, so another account cannot swap or read it.
 */
export async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label}（${directory}）不是真实目录（可能是符号链接），服务器浏览器拒绝使用。请换成当前用户自己的普通目录后重试。`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${label}（${directory}）不属于运行 daemon 的用户，服务器浏览器拒绝使用。请修改目录属主或换一个目录后重试。`);
  if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
}

/** Read a small JSON file the plugin wrote itself: no symbolic link, no FIFO or device, and at most maxBytes. */
export async function readPrivateJson(file: string, maxBytes: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('不是普通文件。');
    if (info.size > maxBytes) throw new Error('文件过大。');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('文件过大。');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
