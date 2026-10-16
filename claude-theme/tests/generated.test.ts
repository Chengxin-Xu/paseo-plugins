import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customPalette, DEFAULT_CUSTOM } from "../shared/custom.ts";
import { DEFAULT_PALETTE, FIXED_THEMES } from "../shared/generated/themes.ts";
import { THEMES } from "../shared/palette.ts";
// @ts-expect-error The generator is a plain script without type declarations.
import { OUTPUT, render } from "../scripts/generate-themes.mjs";

// Clients get the palettes as constants (`shared/generated/themes.ts`), so the colour maths stays out of the resident
// stub. These checks keep the constants and the recipe from drifting apart.

test("the generated themes file is current (npm run generate)", async () => {
  assert.equal(readFileSync(OUTPUT, "utf8"), await render(), "shared/generated/themes.ts is stale: run `npm run generate`");
});

test("the twelve constants are the recipe's themes byte for byte, and 0.5.1's colours", () => {
  assert.equal(JSON.stringify(FIXED_THEMES), JSON.stringify(THEMES));
  const shipped = JSON.parse(readFileSync(new URL("./fixtures/presets-0.5.1.json", import.meta.url), "utf8")) as Record<string, unknown>;
  delete shipped.$comment;
  assert.equal(JSON.stringify(Object.fromEntries(FIXED_THEMES.map((theme) => [theme.id, theme.colors]))), JSON.stringify(shipped));
});

test("the fallback palette is the default parameters' palette", () => {
  assert.equal(JSON.stringify(DEFAULT_PALETTE), JSON.stringify(customPalette(DEFAULT_CUSTOM)));
});
