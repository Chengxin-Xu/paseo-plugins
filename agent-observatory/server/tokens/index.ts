import type { PaseoApi } from "../paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { StatsDirectory } from "../stats-directory";
import type { TokenCallSource } from "../token-source";
import { getTokenLive, getTokens } from "../../shared/tokens";
import { TokenStore } from "./store";
import { buildTokenLive } from "./live";
import { LocalTokenCallSource } from "./source";

export interface TokenModule {
  source: TokenCallSource;
  /** Looks for custom provider log roots in the daemon config (rate limited; safe to call on every hook). */
  discover(paseo: PaseoApi): void;
  close(): Promise<void>;
}

/** Background provider-log ingestion; RPC reads only project the in-memory ledger. */
export function registerTokens(server: PluginServerContext, deps: { directory: StatsDirectory }): TokenModule {
  const store = new TokenStore({ agents: deps.directory });
  server.handle(getTokens, (input, { paseo }) => { void store.discover(paseo); return store.read(input, paseo); });
  server.handle(getTokenLive, (input, { paseo }) => {
    void deps.directory.refresh(paseo); void store.discover(paseo);
    return buildTokenLive(store.data, input, Date.now(), deps.directory);
  });
  return { source: new LocalTokenCallSource(store.ingester, store.initialized), discover: paseo => { void store.discover(paseo); }, close: () => store.close() };
}
