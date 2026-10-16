import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every connection downloads the resident stub (`index.client.tsx`), phones over the relay included. The colour maths,
// the settings schema and the screens belong to the server and the lazy chunk; this keeps them out of the stub.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const RECIPE = ["shared/color.ts", "shared/palette.ts", "shared/custom.ts", "shared/settings.ts", "client/live-theme.ts", "client/editor.tsx"];

/** Files the bundler follows from `entry`: relative imports and re-exports, minus type-only ones (erased). */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gm)) {
      if (match[1]) continue;
      let target = relative(root, join(root, dirname(file), match[2]!));
      if (!existsSync(join(root, target))) target = [".ts", ".tsx"].map((extension) => target + extension).find((candidate) => existsSync(join(root, candidate))) ?? target;
      queue.push(target);
    }
  }
  return seen;
}

test("the resident stub reaches no colour maths, schema or screen code", () => {
  const files = reachable("index.client.tsx");
  assert.ok(files.has("client/slot.ts") && files.has("shared/generated/themes.ts"), "the crawl follows imports");
  assert.deepEqual(RECIPE.filter((file) => files.has(file)), []);
});

test("the lazy chunk and the server do carry the recipe", () => {
  assert.ok(reachable("ui-chunk.client.tsx").has("shared/custom.ts"));
  assert.ok(reachable("index.server.ts").has("shared/settings.ts"));
});
