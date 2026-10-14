import type { PaseoApi } from "../paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { StatsDirectory } from "../stats-directory";
import { digestSchema } from "../../shared/digest";
import { getTokenLive, getTokens, type TokenSource } from "../../shared/tokens";
import { TokenStore, type TokenStoreOptions } from "./store";
import { buildTokenLive } from "./live";
import { LocalTokenCallSource } from "./source";

export interface TokenModule {
  /** 复盘's token calls, and 恢复后续跑's marker look-up in a session's own logs after a restart (server/resume). */
  source: LocalTokenCallSource;
  /** Looks for custom provider log roots in the daemon config (rate limited; safe to call on every hook). */
  discover(paseo: PaseoApi): void;
  close(): Promise<void>;
}

/**
 * The log sources 复盘 can show (its `tokens.source`, shared/digest): a session of another source is left out of its
 * token history rather than failing the whole digest, until that schema lists the source too.
 */
export const digestTokenSources = (): ReadonlySet<TokenSource> => new Set(digestSchema.shape.tokens.unwrap().shape.source.options);

/**
 * Background provider-log ingestion; RPC reads only project the in-memory ledger. `zones` (server/device-zone) learns the
 * device's time zone from the Token page's reads, as it does from the statistics pages'. `store`: roots, data directory
 * and clock for tests.
 */
export function registerTokens(server: PluginServerContext, deps: { directory: StatsDirectory; zones?: { note(zone: unknown): void }; store?: Omit<TokenStoreOptions, "agents"> }): TokenModule {
  const store = new TokenStore({ ...deps.store, agents: deps.directory });
  server.handle(getTokens, (input, { paseo }) => { deps.zones?.note(input.timeZone); void store.discover(paseo); return store.read(input, paseo); });
  server.handle(getTokenLive, (input, { paseo }) => {
    deps.zones?.note(input.timeZone); void deps.directory.refresh(paseo); void store.discover(paseo);
    return buildTokenLive(store.data, input, Date.now(), deps.directory);
  });
  return { source: new LocalTokenCallSource(store.ingester, store.initialized, { sources: digestTokenSources() }), discover: paseo => { void store.discover(paseo); }, close: () => store.close() };
}
