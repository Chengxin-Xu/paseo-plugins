import type { TokenSource } from "../shared/tokens";

/** One model call read from a provider log, normalised as in shared/tokens.ts. Times are epoch ms. */
export interface TokenCall {
  /** Response end: timestamp of the response's last log line. */
  at: number;
  /** Request start when known (timestamp of the log line the response answers), else null. */
  start: number | null;
  model: string | null;
  input: number; cacheWrite: number; cacheRead: number; output: number; reasoning: number;
  /** Made by one of the session's subagents (Claude `subagents/*.jsonl` or `isSidechain`). */
  subagent: boolean;
}

/** What the execution digest needs from the token ledger (implemented in server/tokens, consumed by server/digest). */
export interface TokenCallSource {
  /**
   * Calls of the given provider sessions (Paseo `persistence.sessionId`; resumed or forked continuations of the same
   * conversation are included when the ledger can link them), oldest first. Null when none of them has a local log.
   */
  callsForSessions(sessionIds: readonly string[]): Promise<{ source: TokenSource; calls: TokenCall[] } | null>;
}
