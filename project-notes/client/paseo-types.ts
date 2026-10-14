import type { PluginClientContext } from "@getpaseo/plugin/client";

// Paseo's client API types, reached through the plugin SDK. @getpaseo/client is only a dev dependency: a host installing this
// plugin from Git runs a production install and cannot resolve it for the client bundle.
export type PaseoApi = PluginClientContext["paseo"];
export type PaseoAgentListResult = Awaited<ReturnType<PaseoApi["agents"]["list"]>>;
export type PaseoAgentUpdate = Parameters<Parameters<PaseoApi["agents"]["subscribe"]>[0]>[0];
