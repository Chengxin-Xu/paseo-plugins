import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { composerCapabilitiesRpc } from "../shared/composer";

let home = "", previousHome: string | undefined;
beforeEach(async () => { previousHome = process.env.PASEO_HOME; home = await mkdtemp(join(tmpdir(), "notes-capabilities-")); process.env.PASEO_HOME = home; });
afterEach(async () => { process.env.PASEO_HOME = previousHome; await rm(home, { recursive: true, force: true }); });
it("exposes the configured custom provider's distinct ordinary and slash steering lists through the RPC", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { "review-helper": { extends: "claude" }, "build-helper": { extends: "codex" }, "other-helper": { extends: "acp" } } } }));
  const handlers = new Map<string, () => Promise<unknown>>();
  const server = { handle: (contract: PluginRpcContract, handler: () => Promise<unknown>) => handlers.set(contract.name, handler) };
  const cleanup = contribute(server as unknown as PluginServerContext);
  try {
    const result = composerCapabilitiesRpc.output.parse(await handlers.get(composerCapabilitiesRpc.name)!());
    expect(result.steerableProviders).toContain("review-helper");
    expect(result.steerableProviders).toContain("build-helper");
    expect(result.slashSteerableProviders).toContain("review-helper");
    expect(result.slashSteerableProviders).not.toContain("build-helper");
    expect(result.steerableProviders).not.toContain("other-helper");
  } finally { await cleanup(); }
});
