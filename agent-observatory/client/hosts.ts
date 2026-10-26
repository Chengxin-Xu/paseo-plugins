import * as host from "@getpaseo/plugin/client";
import { useMemo } from "react";

type HostSummary = { readonly serverId: string; readonly label: string };
const NONE: readonly HostSummary[] = [];
// `useHosts` (Paseo 0.11+) lists the hosts this app has added; a host without it (the preview, a test) names none.
const useHostList: () => readonly HostSummary[] = typeof (host as { useHosts?: unknown }).useHosts === "function"
  ? (host as unknown as { useHosts(): readonly HostSummary[] }).useHosts : () => NONE;

/** The app's names for its hosts, by server id. A host this app has not added has no name here. */
export function useHostLabels(): ReadonlyMap<string, string> {
  const hosts = useHostList();
  return useMemo(() => new Map(hosts.map(entry => [entry.serverId, entry.label])), [hosts]);
}
