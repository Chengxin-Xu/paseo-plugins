import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import contribute from "../index.client.ts";
import { THEMES } from "../shared/palette.ts";

/** Only addTheme is exercised, so the rest of the context stays unimplemented on purpose. */
function fakeClient() {
  const added: PluginThemeContribution[] = [];
  const removed: string[] = [];
  const client = {
    addTheme(theme: PluginThemeContribution) {
      added.push(theme);
      return () => void removed.push(theme.id);
    },
  } as unknown as PluginClientContext;
  return { client, added, removed };
}

test("the client entry registers every theme once", () => {
  const { client, added } = fakeClient();
  contribute(client);
  assert.deepEqual(added, [...THEMES]);
});

test("cleanup removes exactly what it registered", () => {
  const { client, added, removed } = fakeClient();
  const cleanup = contribute(client);
  cleanup();
  assert.deepEqual(removed, added.map((theme) => theme.id));
});
