import { closeSync, constants, fstatSync, opendirSync, openSync, readSync, readlinkSync, statSync } from 'node:fs';
import os from 'node:os';

/**
 * Listening TCP sockets of processes that Agents started, read from /proc on a Linux daemon host.
 *
 * Adapted from alessandrocornacchia/paseo-port-forward/server/scan.ts (MIT, see NOTICE): decoding /proc/net/tcp and
 * /proc/net/tcp6 addresses, finding a socket's process through the `socket:[inode]` links in /proc/<pid>/fd, and walking
 * parent chains. That plugin runs a shell script on a remote host over SSH; here the plugin process reads /proc itself:
 * - only processes of the plugin's own user are read (the owner is checked before any read); the plugin's own process
 *   tree (its Chromium) and other Paseo daemons' trees are skipped;
 * - each table is read up to the end of its listening sockets (the kernel lists them first), at most 4 MiB;
 * - a process' `environ` is read only once it owns a listening socket, at most 128 KiB, and only PASEO_AGENT_ID and
 *   PASEO_AGENT_CWD are kept (the buffer is zeroed); command lines are never read, the name comes from `stat`;
 * - files open with O_NOFOLLOW and must be regular files; descriptor links are read, never followed;
 * - a scan has a deadline and caps on processes and descriptors; reaching one marks the result partial.
 * An owner found once is re-checked with three small reads per scan; the full walk runs only for a socket not seen before.
 *
 * Processes that left the daemon's tree (nohup, setsid, a parent that exited) are found too: they keep the
 * PASEO_AGENT_ID they inherited. Whether that Agent belongs to this daemon is decided by the caller (server/agent-ports.ts).
 */
export const PORT_SCAN_LIMITS = Object.freeze({
  durationMs: 2_000,
  tableBytes: 4 * 1024 * 1024,
  directoryEntries: 65_536,
  processes: 4_096,
  statBytes: 4 * 1024,
  environBytes: 128 * 1024,
  fdsPerProcess: 4_096,
  fds: 65_536,
  concurrency: 8,
  /**
   * A socket that no Agent process owns is not looked for again this long (unless the walk that missed it was partial):
   * a socket keeps its owner's environment for life, so this only bounds how long an unforeseen change could go unseen.
   */
  foreignMs: 5 * 60_000,
  /** Processes whose Agent variables are remembered (by PID and start time). */
  environCache: 4_096,
});
export type PortScanLimits = { [K in keyof typeof PORT_SCAN_LIMITS]: number };

export type SocketFamily = 'tcp' | 'tcp6';
export interface ListenSocket { family: SocketFamily; address: string; port: number; inode: string }
export interface ProcRow { pid: number; ppid: number; name: string; startTicks: number }
export interface AgentEnv { agentId: string | null; agentCwd: string | null }
/** fd: the descriptor that held the socket, re-read to confirm the owner on the next scan. */
export interface PortOwner { pid: number; startTicks: number; fd: string; name: string; agentId: string; agentCwd: string | null }
export interface OwnedSocket extends ListenSocket { owner: PortOwner }
/** supported: false on hosts without /proc/net (not Linux); partial: a cap, the deadline or an unreadable table cut the scan short. */
export interface PortScan { supported: boolean; sockets: OwnedSocket[]; partial: boolean; scannedAt: number }

/** The /proc reads a scan needs. The real one (procIo) opens nothing else; tests pass fakes. */
export interface ProcIo {
  /** The table's head up to its last listening socket; null when the table does not exist. */
  readNetTable(file: '/proc/net/tcp' | '/proc/net/tcp6', maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean } | null>;
  listPids(limit: number, signal: AbortSignal): Promise<{ pids: number[]; truncated: boolean }>;
  /** The user owning /proc/<pid>; null when the process is gone. */
  ownerOf(pid: number): Promise<number | null>;
  /** `/proc/<pid>/stat` or `/proc/<pid>/environ`, the first `maxBytes` (truncated: there was more). */
  read(file: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Buffer; truncated: boolean }>;
  listFds(pid: number, limit: number, signal: AbortSignal): Promise<{ fds: string[]; truncated: boolean }>;
  readLink(pid: number, fd: string): Promise<string | null>;
}

const LISTEN = '0A';
const DAEMON_NAME = 'Paseo Daemon';
const littleEndian = os.endianness() === 'LE';

/** One 32-bit word of an address as the kernel prints it (`%08X` of a value in host byte order) → its four bytes in network order. */
function wordBytes(hex: string, swap: boolean): number[] {
  const bytes = [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return swap ? bytes.reverse() : bytes;
}

function compressIpv6(groups: number[]): string {
  let bestStart = -1, bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index++; continue; }
    let end = index;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - index > bestLength && end - index > 1) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** A /proc/net/tcp(6) local address (`0100007F:0BB8`) → address and port. IPv4-mapped IPv6 addresses come back as IPv4. */
export function decodeProcAddress(family: SocketFamily, value: string, swap = littleEndian): { address: string; port: number } | null {
  const match = (family === 'tcp' ? /^([0-9A-Fa-f]{8}):([0-9A-Fa-f]{4})$/ : /^([0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/).exec(value);
  if (!match) return null;
  const hex = match[1], port = Number.parseInt(match[2], 16);
  if (family === 'tcp') return { address: wordBytes(hex, swap).join('.'), port };
  const bytes = [0, 8, 16, 24].flatMap((offset) => wordBytes(hex.slice(offset, offset + 8), swap));
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return { address: bytes.slice(12).join('.'), port };
  const groups = [0, 2, 4, 6, 8, 10, 12, 14].map((offset) => bytes[offset] * 256 + bytes[offset + 1]);
  return { address: compressIpv6(groups), port };
}

/** Where a socket listens: every address, loopback only, or one other address. */
export type ListenScope = 'all' | 'local' | 'address';
export function scopeOf(address: string): ListenScope {
  if (address === '0.0.0.0' || address === '::') return 'all';
  if (address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return 'local';
  return 'address';
}
/**
 * The host the shared browser connects to, in the socket's own address family: 127.0.0.1 for the IPv4 wildcard or
 * 127.0.0.1 itself; [::1] for the IPv6 wildcard, which may accept IPv6 only (IPV6_V6ONLY, or bindv6only=1) so that
 * 127.0.0.1 could reach nothing or another process' IPv4 socket on the same port; else the address (IPv6 in brackets).
 */
export function connectHost(address: string): string {
  if (address === '0.0.0.0' || address === '127.0.0.1') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * The listening sockets of one table owned by `uid`. ended: a line in another state was seen, so the table's listening
 * sockets (listed first) are all in `text`.
 */
export function parseNetTable(text: string, family: SocketFamily, uid: number, swap = littleEndian): { sockets: ListenSocket[]; ended: boolean } {
  const sockets: ListenSocket[] = [];
  let ended = false;
  // A line cut off by the read limit could end in the middle of its inode: only complete lines count.
  const lines = text.split('\n').slice(0, -1);
  for (let index = 1; index < lines.length; index++) {
    const fields = lines[index].trim().split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== LISTEN) { ended = true; continue; }
    if (fields[7] !== String(uid) || !/^[1-9]\d{0,19}$/.test(fields[9])) continue;
    const decoded = decodeProcAddress(family, fields[1], swap);
    if (!decoded || decoded.port < 1) continue;
    sockets.push({ family, inode: fields[9], ...decoded });
  }
  return { sockets, ended };
}

/** `/proc/<pid>/stat`: the name sits between the first "(" and the last ") " and may contain spaces or parentheses. */
export function parseStat(text: string): Omit<ProcRow, 'pid'> | null {
  const open = text.indexOf('('), close = text.lastIndexOf(') ');
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]), startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(startTicks) || startTicks < 0) return null;
  return { name: text.slice(open + 1, close), ppid, startTicks };
}

/** A process name for display: its first word only (a name a process set itself may carry arguments), no control characters. */
export function programName(name: string): string {
  return (name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().split(/\s+/)[0] ?? '').replace(/:$/, '').slice(0, 32);
}

const AGENT_ID = Buffer.from('PASEO_AGENT_ID='), AGENT_CWD = Buffer.from('PASEO_AGENT_CWD=');
const utf8 = new TextDecoder('utf-8', { fatal: true });
/**
 * PASEO_AGENT_ID and PASEO_AGENT_CWD from a process environment, nothing else: other entries are compared by prefix and
 * never turned into strings. A malformed value counts as missing; an entry cut off by the read limit is ignored.
 */
export function readAgentEnv(environ: Buffer): AgentEnv {
  const found: AgentEnv = { agentId: null, agentCwd: null };
  let start = 0;
  while (start < environ.length) {
    const end = environ.indexOf(0, start);
    if (end === -1) break;
    const entry = environ.subarray(start, end);
    if (found.agentId === null && entry.subarray(0, AGENT_ID.length).equals(AGENT_ID)) {
      const value = entry.subarray(AGENT_ID.length);
      if (value.length <= 128) { const id = value.toString('latin1'); if (/^[A-Za-z0-9_-]+$/.test(id)) found.agentId = id; }
    } else if (found.agentCwd === null && entry.subarray(0, AGENT_CWD.length).equals(AGENT_CWD)) {
      const value = entry.subarray(AGENT_CWD.length);
      if (value.length > 0 && value.length <= 4096) {
        try { const cwd = utf8.decode(value); if (cwd.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(cwd)) found.agentCwd = cwd; } catch { /* not UTF-8 */ }
      }
    }
    start = end + 1;
  }
  return found;
}

/** `socket:[12345]` → the socket's inode; anything else (files, pipes, anonymous inodes) → null. */
export function socketInode(link: string | null): string | null {
  return link ? /^socket:\[([1-9]\d{0,19})\]$/.exec(link)?.[1] ?? null : null;
}

/** This daemon: the nearest "Paseo Daemon" above the plugin process, else the plugin process' parent (the host starts plugins). */
export function findDaemon(rows: readonly ProcRow[], selfPid: number): number | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const visited = new Set<number>();
  let cursor = byPid.get(selfPid);
  while (cursor && !visited.has(cursor.pid)) {
    visited.add(cursor.pid);
    if (cursor.name === DAEMON_NAME) return cursor.pid;
    cursor = byPid.get(cursor.ppid);
  }
  const self = byPid.get(selfPid);
  return self && self.ppid > 1 ? self.ppid : null;
}

/**
 * For every process, the nearest "Paseo Daemon" at or above it (null: none). A process belongs to that daemon: another
 * daemon started below this one (an Agent's test daemon) keeps its own processes, and this one stays this daemon's even
 * when it was itself started below another. Walks are memoized and cycle-safe.
 */
export function nearestDaemons(rows: readonly ProcRow[]): Map<number, number | null> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const nearest = new Map<number, number | null>();
  for (const row of rows) {
    const chain: number[] = [], seen = new Set<number>();
    let cursor: ProcRow | undefined = row, found: number | null = null;
    while (cursor && !seen.has(cursor.pid)) {
      if (nearest.has(cursor.pid)) { found = nearest.get(cursor.pid)!; break; }
      seen.add(cursor.pid);
      chain.push(cursor.pid);
      if (cursor.name === DAEMON_NAME) { found = cursor.pid; break; }
      cursor = byPid.get(cursor.ppid);
    }
    for (const pid of chain) nearest.set(pid, found);
  }
  return nearest;
}

/** `roots` and every process below them (cycle-safe: a racing scan can see a reused PID). */
export function descendantsOf(roots: readonly number[], rows: readonly ProcRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const result = new Set<number>(), pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (result.has(pid)) continue;
    result.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

/** Lets timers (the scan deadline) and other plugin work run between processes. */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Runs `task` over `items`, at most `concurrency` at a time, until done or aborted, yielding to the event loop between items. */
async function mapLimited<T>(items: readonly T[], concurrency: number, signal: AbortSignal, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!signal.aborted && cursor < items.length) { await task(items[cursor++]); await breathe(); }
  }));
}

/*
 * The real reads are synchronous system calls on /proc (each a few microseconds), wrapped in the async interface: a
 * thread-pool round trip per descriptor link would cost several times more CPU than the read itself (a full walk over
 * ~4,000 descriptors: about 35 ms instead of 200 ms). Scans yield to the event loop between processes.
 */
const PROC_FILE = /^\/proc\/[1-9]\d*\/(?:stat|environ)$/;
function readHead(file: string, maxBytes: number, signal: AbortSignal, stop?: (data: Buffer, from: number) => boolean): { data: Buffer; truncated: boolean } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024)), size = 0;
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    for (;;) {
      if (signal.aborted) throw new Error('scan deadline');
      if (size === buffer.length) {
        if (size > maxBytes) break;
        const grown = Buffer.alloc(Math.min(maxBytes + 1, buffer.length * 2));
        buffer.copy(grown, 0, 0, size);
        buffer.fill(0);
        buffer = grown;
      }
      const bytesRead = readSync(fd, buffer, size, buffer.length - size, null);
      if (bytesRead <= 0) break;
      const from = size;
      size += bytesRead;
      if (stop?.(buffer.subarray(0, size), from)) break;
    }
    return { data: Buffer.from(buffer.subarray(0, Math.min(size, maxBytes))), truncated: size > maxBytes };
  } finally {
    buffer.fill(0);
    closeSync(fd);
  }
}

/** Whether the bytes read so far hold a complete table line in a state other than LISTEN (the listening part is over). */
function pastListening(data: Buffer, from: number): boolean {
  let lineStart = data.lastIndexOf(0x0a, Math.max(0, from - 1)) + 1;
  for (let end = data.indexOf(0x0a, lineStart); end !== -1; end = data.indexOf(0x0a, lineStart)) {
    const fields = data.subarray(lineStart, end).toString('latin1').trim().split(/\s+/);
    if (fields.length >= 10 && fields[0] !== 'sl' && fields[3] !== LISTEN) return true;
    lineStart = end + 1;
  }
  return false;
}

/** At most `limit` entry names of a directory that pass `accept`; truncated: more were left (or `visit` entries were seen). */
function listDirectory(path: string, limit: number, visit: number, signal: AbortSignal, accept: (name: string) => boolean): { names: string[]; truncated: boolean } {
  const names: string[] = [];
  let visited = 0, truncated = false;
  const directory = opendirSync(path);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (signal.aborted || ++visited > visit || names.length >= limit) { truncated = true; break; }
      if (accept(entry.name)) names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return { names, truncated };
}

export const procIo: ProcIo = {
  async readNetTable(file, maxBytes, signal) {
    try {
      const { data, truncated } = readHead(file, maxBytes, signal, pastListening);
      return { text: data.toString('latin1'), truncated };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'ENOENT') return null;
      throw error;
    }
  },
  async listPids(limit, signal) {
    const { names, truncated } = listDirectory('/proc', limit, PORT_SCAN_LIMITS.directoryEntries, signal, (name) => /^[1-9]\d{0,9}$/.test(name));
    return { pids: names.map(Number), truncated };
  },
  async ownerOf(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { return statSync(`/proc/${pid}`).uid; } catch { return null; }
  },
  async read(file, maxBytes, signal) {
    if (!PROC_FILE.test(file)) throw new Error('unsupported process file');
    return readHead(file, maxBytes, signal);
  },
  async listFds(pid, limit, signal) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { fds: [], truncated: false };
    const { names, truncated } = listDirectory(`/proc/${pid}/fd`, limit, Number.MAX_SAFE_INTEGER, signal, (name) => /^\d{1,10}$/.test(name));
    return { fds: names, truncated };
  },
  async readLink(pid, fd) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d{1,10}$/.test(fd)) return null;
    try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return null; }
  },
};

export interface PortScannerOptions {
  io?: ProcIo;
  /** The plugin's user; null (no getuid) means the scan is not supported. */
  uid?: number | null;
  /** The plugin process: its own tree (Chromium, the control endpoint) is never listed. */
  selfPid?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
  limits?: Partial<PortScanLimits>;
}

/** Scans on demand; caches owners between scans so a quiet host costs a few reads per listening socket. */
export class PortScanner {
  private readonly io: ProcIo;
  private readonly uid: number | null;
  private readonly selfPid: number;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly limits: PortScanLimits;
  /** inode → the Agent process holding it, confirmed on every scan. */
  private readonly owners = new Map<string, PortOwner>();
  /** inode → until when it is known to belong to no Agent process. */
  private readonly foreign = new Map<string, number>();
  /**
   * `pid:startTicks` → its Agent variables, read once per process. A process that exec's keeps its PID and start time, so
   * an exec into another environment after the first read goes unseen (rare for a process that already listens).
   */
  private readonly environs = new Map<string, AgentEnv | null>();

  constructor(options: PortScannerOptions = {}) {
    this.io = options.io ?? procIo;
    this.uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null;
    this.selfPid = options.selfPid ?? process.pid;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.limits = { ...PORT_SCAN_LIMITS, ...options.limits };
  }

  async scan(): Promise<PortScan> {
    const scannedAt = this.now();
    if (this.platform !== 'linux' || this.uid === null) return { supported: false, sockets: [], partial: false, scannedAt };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.durationMs);
    timer.unref?.();
    const state = { signal: controller.signal, partial: false };
    try {
      const tables = await Promise.all((['/proc/net/tcp', '/proc/net/tcp6'] as const).map(async (file) => {
        try { return await this.io.readNetTable(file, this.limits.tableBytes, state.signal); } catch { state.partial = true; return undefined; }
      }));
      if (tables.every((table) => table === null)) return { supported: false, sockets: [], partial: false, scannedAt };
      const listening: ListenSocket[] = [];
      tables.forEach((table, index) => {
        if (!table) return;
        const parsed = parseNetTable(table.text, index === 0 ? 'tcp' : 'tcp6', this.uid!);
        if (table.truncated && !parsed.ended) state.partial = true;
        listening.push(...parsed.sockets);
      });
      const wanted = new Set(listening.map((socket) => socket.inode));
      for (const inode of [...this.owners.keys()]) if (!wanted.has(inode)) this.owners.delete(inode);
      const now = this.now();
      for (const [inode, until] of [...this.foreign]) if (!wanted.has(inode) || until <= now) this.foreign.delete(inode);
      await mapLimited([...this.owners], this.limits.concurrency, state.signal, async ([inode, owner]) => {
        if (!(await this.confirm(owner, inode, state.signal))) this.owners.delete(inode);
      });
      if (state.signal.aborted) state.partial = true;
      const unresolved = new Set([...wanted].filter((inode) => !this.owners.has(inode) && !this.foreign.has(inode)));
      if (unresolved.size && !state.signal.aborted) await this.walk(unresolved, state);
      const sockets = listening.filter((socket) => this.owners.has(socket.inode)).map((socket) => ({ ...socket, owner: this.owners.get(socket.inode)! }));
      return { supported: true, sockets, partial: state.partial, scannedAt };
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  /** The cached owner still runs (same start time, same user) and still holds the socket on the same descriptor. */
  private async confirm(owner: PortOwner, inode: string, signal: AbortSignal): Promise<boolean> {
    try {
      if ((await this.io.ownerOf(owner.pid)) !== this.uid) return false;
      const stat = parseStat((await this.io.read(`/proc/${owner.pid}/stat`, this.limits.statBytes, signal)).data.toString('utf8'));
      if (!stat || stat.startTicks !== owner.startTicks) return false;
      return socketInode(await this.io.readLink(owner.pid, owner.fd)) === inode;
    } catch {
      return false;
    }
  }

  /** Finds the processes holding `unresolved` sockets: this user's processes, outside the plugin's and other daemons' trees. */
  private async walk(unresolved: Set<string>, state: { signal: AbortSignal; partial: boolean }): Promise<void> {
    const { signal } = state, limits = this.limits;
    const listed = await this.io.listPids(limits.directoryEntries, signal).catch(() => ({ pids: [] as number[], truncated: true }));
    if (listed.truncated) state.partial = true;
    const rows: ProcRow[] = [];
    let budget = limits.processes;
    await mapLimited(listed.pids, limits.concurrency, signal, async (pid) => {
      if ((await this.io.ownerOf(pid)) !== this.uid) return;
      if (budget-- <= 0) { state.partial = true; return; }
      try {
        const stat = parseStat((await this.io.read(`/proc/${pid}/stat`, limits.statBytes, signal)).data.toString('utf8'));
        if (stat) rows.push({ pid, ...stat });
      } catch { /* gone, or the deadline */ }
    });
    const daemon = findDaemon(rows, this.selfPid), nearest = nearestDaemons(rows), own = descendantsOf([this.selfPid], rows);
    // Searched: this daemon's processes and those under no daemon at all (left their tree); never another daemon's.
    const candidates = rows.filter((row) => {
      const owner = nearest.get(row.pid) ?? null;
      return row.pid > 1 && row.pid !== daemon && !own.has(row.pid) && (owner === null || owner === daemon);
    });
    const found = new Map<string, { row: ProcRow; fd: string }>();
    let descriptors = limits.fds;
    await mapLimited(candidates, limits.concurrency, signal, async (row) => {
      if (found.size >= unresolved.size) return;
      let listing: { fds: string[]; truncated: boolean };
      try { listing = await this.io.listFds(row.pid, limits.fdsPerProcess, signal); } catch { return; }
      if (listing.truncated) state.partial = true;
      for (const fd of listing.fds) {
        if (signal.aborted || found.size >= unresolved.size) return;
        if (descriptors-- <= 0) { state.partial = true; return; }
        const inode = socketInode(await this.io.readLink(row.pid, fd));
        if (inode && unresolved.has(inode) && !found.has(inode)) found.set(inode, { row, fd });
      }
    });
    if (signal.aborted) state.partial = true;
    const until = this.now() + limits.foreignMs;
    for (const [inode, { row, fd }] of found) {
      const env = await this.agentEnv(row, signal);
      if (env?.agentId) this.owners.set(inode, { pid: row.pid, startTicks: row.startTicks, fd, name: row.name, agentId: env.agentId, agentCwd: env.agentCwd });
      else if (env !== undefined) this.foreign.set(inode, until);
    }
    // A complete walk proves the rest are held by no process it may read (other users, other daemons, the plugin).
    if (!state.partial) for (const inode of unresolved) if (!found.has(inode)) this.foreign.set(inode, until);
    const live = new Set(rows.map((row) => `${row.pid}:${row.startTicks}`));
    for (const key of [...this.environs.keys()]) if (!live.has(key)) this.environs.delete(key);
  }

  /** The two Agent variables of a process, read once per process; undefined when the read failed and may succeed later. */
  private async agentEnv(row: ProcRow, signal: AbortSignal): Promise<AgentEnv | null | undefined> {
    const key = `${row.pid}:${row.startTicks}`;
    if (this.environs.has(key)) return this.environs.get(key);
    let data: Buffer | undefined;
    try {
      if ((await this.io.ownerOf(row.pid)) !== this.uid) return null;
      const read = await this.io.read(`/proc/${row.pid}/environ`, this.limits.environBytes, signal);
      data = read.data;
      const env = readAgentEnv(data);
      // The PID may have been reused since the walk listed it: only the process that was listed counts.
      const stat = parseStat((await this.io.read(`/proc/${row.pid}/stat`, this.limits.statBytes, signal)).data.toString('utf8'));
      if (stat?.startTicks !== row.startTicks) return undefined;
      // An environment cut off before PASEO_AGENT_ID may still hold it: no verdict, but the process is not listed either.
      const value = env.agentId || !read.truncated ? env : null;
      if (this.environs.size >= this.limits.environCache) this.environs.delete(this.environs.keys().next().value!);
      this.environs.set(key, value);
      return value;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'EACCES' || code === 'EPERM') { this.environs.set(key, null); return null; }
      return undefined;
    } finally {
      data?.fill(0);
    }
  }
}
