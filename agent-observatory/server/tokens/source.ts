import { stat } from "node:fs/promises";
import type { TokenSource } from "../../shared/tokens";
import type { TokenCall, TokenCallSource } from "../token-source";
import type { TokenIngester } from "./ingester";
import { initialParser, validStart } from "./parser";
import { tailFile } from "./reader";
import { safeError, type Candidate, type LogFile, type ParserState } from "./types";

const MAX_FILES = 8, MAX_CALLS = 20_000;
interface CachedFile { file: LogFile; calls: Map<string, Candidate> }
interface OwnedCandidate { candidate: Candidate; path: string }
interface FileLinks { ids: string[]; links: string[] }

function freshFile(file: LogFile): LogFile {
  return { ...file, offset: 0, partialBytes: 0, imported: false, state: initialParser(file.path, file.parentSession) };
}
function copy(candidate: Candidate): Candidate { return { forked: candidate.forked, call: { ...candidate.call } }; }
function merge(previous: Candidate, next: Candidate, contiguous = false): Candidate {
  if (previous.forked !== next.forked) return copy(previous.forked ? next : previous);
  const at = Math.max(previous.call.at, next.call.at);
  return { forked: previous.forked, call: { ...previous.call, at,
    start: validStart(contiguous ? next.call.start : previous.call.start, at),
    output: Math.max(previous.call.output, next.call.output), reasoning: Math.max(previous.call.reasoning, next.call.reasoning) } };
}
function publicCall({ at, start, model, input, cacheWrite, cacheRead, output, reasoning, subagent }: TokenCall): TokenCall {
  return { at, start, model, input, cacheWrite, cacheRead, output, reasoning, subagent };
}

/** On-demand call history; the ledger itself never retains full history for every provider session. */
export class LocalTokenCallSource implements TokenCallSource {
  private readonly cache = new Map<string, CachedFile>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly ingester: TokenIngester, private readonly initialized: Promise<unknown> = Promise.resolve()) {}

  callsForSessions(sessionIds: readonly string[]): Promise<{ source: TokenSource; calls: TokenCall[] } | null> {
    const ids = [...new Set(sessionIds)];
    const request = this.pending.then(async () => { await this.initialized; return this.readSessions(ids); });
    // A failed initialization/read must not leave subsequent requests attached to a rejected queue.
    this.pending = request.catch(() => {});
    return request;
  }

  private links(file: LogFile, discovered: Map<string, ParserState>): FileLinks {
    const states = [file.state, this.cache.get(file.path)?.file.state, discovered.get(file.path)].filter((state): state is ParserState => !!state);
    return { ids: [...new Set([initialParser(file.path, file.parentSession).sessionId, file.parentSession ?? "",
      ...states.flatMap(state => [state.sessionId, ...state.sessions])].filter(Boolean))],
    links: [...new Set(states.flatMap(state => state.links))] };
  }

  private related(files: LogFile[], source: TokenSource, sessionIds: readonly string[], discovered: Map<string, ParserState>): LogFile[] {
    const connected = new Set(sessionIds), candidates = files.filter(file => file.source === source).map(file => ({ file, ...this.links(file, discovered) }));
    let changed = true;
    while (changed) {
      changed = false;
      for (const { ids, links } of candidates) {
        if (![...ids, ...links].some(id => connected.has(id))) continue;
        for (const id of [...ids, ...links]) if (!connected.has(id)) { connected.add(id); changed = true; }
      }
    }
    return candidates.filter(({ ids }) => ids.some(id => connected.has(id))).map(({ file }) => file)
      .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  }

  private keep(entry: CachedFile): void {
    this.cache.delete(entry.file.path);
    if (entry.calls.size > MAX_CALLS) return;
    this.cache.set(entry.file.path, entry);
    let count = [...this.cache.values()].reduce((sum, file) => sum + file.calls.size, 0);
    while (this.cache.size > MAX_FILES || count > MAX_CALLS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      count -= this.cache.get(oldest)!.calls.size;
      this.cache.delete(oldest);
    }
  }

  private async read(file: LogFile): Promise<CachedFile | null> {
    let entry = this.cache.get(file.path);
    try {
      const details = await stat(file.path);
      if (!details.isFile()) { this.cache.delete(file.path); return null; }
      if (entry && details.dev === entry.file.dev && details.ino === entry.file.ino && details.size === entry.file.size && details.mtimeMs === entry.file.mtime) {
        this.keep(entry); return entry;
      }
      if (!entry || details.dev !== entry.file.dev || details.ino !== entry.file.ino || details.size < entry.file.size || details.size < entry.file.offset ||
          (details.size === entry.file.size && details.mtimeMs !== entry.file.mtime)) entry = { file: freshFile(file), calls: new Map() };
      const current = entry;
      let parsedState = current.file.state;
      const reconcileReset = () => {
        // tailFile stats again; a replacement between the two stats must also clear the old call cache.
        if (parsedState !== current.file.state) { current.calls.clear(); parsedState = current.file.state; }
      };
      await tailFile(current.file, (candidate, previous) => {
        reconcileReset();
        const before = current.calls.get(candidate.call.key);
        current.calls.set(candidate.call.key, before ? merge(before, candidate, previous?.call.key === candidate.call.key) : copy(candidate));
      });
      reconcileReset();
      this.keep(current);
      return current;
    } catch (error) {
      const root = this.ingester.roots[file.root];
      if (root) root.error = safeError(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.cache.delete(file.path); return null; }
      // Preserve the last readable counters on transient permission/I/O errors; never retain log bodies.
      return entry ?? { file: freshFile(file), calls: new Map() };
    }
  }

  private async readSessions(sessionIds: readonly string[]): Promise<{ source: TokenSource; calls: TokenCall[] } | null> {
    if (!sessionIds.length) return null;
    const files = [...this.ingester.files.values()], discovered = new Map<string, ParserState>();
    let source: TokenSource | undefined;
    // TokenCallSource has one source. Mixed-provider requests use the first requested known provider session.
    for (const id of sessionIds) {
      const known = files.find(file => { const links = this.links(file, discovered); return links.ids.includes(id) || links.links.includes(id); });
      if (known) { source = known.source; break; }
    }
    if (!source) return null;
    const merged = new Map<string, OwnedCandidate>(), read = new Set<string>();
    let found = false;
    while (true) {
      const selected = this.related(files, source, sessionIds, discovered).filter(file => !read.has(file.path));
      if (!selected.length) break;
      for (const file of selected) {
        read.add(file.path);
        const entry = await this.read(file);
        if (!entry) continue;
        found = true; discovered.set(file.path, entry.file.state);
        for (const candidate of entry.calls.values()) {
          const before = merged.get(candidate.call.key);
          if (!before || (before.candidate.forked && !candidate.forked)) merged.set(candidate.call.key, { candidate: copy(candidate), path: file.path });
          else if (before.path === file.path) before.candidate = merge(before.candidate, candidate);
        }
      }
    }
    if (!found) return null;
    return { source, calls: [...merged.values()].map(({ candidate }) => publicCall(candidate.call)).sort((a, b) => a.at - b.at) };
  }
}
