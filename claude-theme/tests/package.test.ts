import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES } from "../shared/palette.ts";

// The registry reads the listing (name, icon, screenshots, overview) straight from the files
// shipped beside the manifest, so these guard what a reviewer and the Paseo app will see.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = json("paseo-plugin.json");
const ossExport = existsSync(join(root, "oss-export.json")) ? json("oss-export.json") : null;
const pkg = json("package.json");

function pngSize(path: string) {
  const bytes = readFileSync(join(root, path));
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

test("the manifest names the listing and points at shipped PNGs", () => {
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.trim().length > 0);
  assert.doesNotMatch(manifest.name, /claude|anthropic/i, "the listing is unofficial");
  assert.ok(manifest.description?.trim(), "the registry card shows the description");

  // Guard the public export overlay in oss-export.json when running in the source repo.
  if (ossExport) {
    const exported = { ...manifest, ...ossExport.manifest };
    assert.equal(exported.id, "terracotta-themes");
    assert.doesNotMatch(exported.name, /claude|anthropic/i);
    assert.doesNotMatch(exported.description, /claude|anthropic/i);
  }

  const icon = pngSize(manifest.icon);
  assert.equal(icon.width, icon.height, "icon must be square");
  assert.ok(icon.width >= 512, `icon is ${icon.width} px`);

  // Verify the swatch fan in assets/icon.svg matches the anchor themes' current hex values.
  const iconSvg = readFileSync(join(root, "assets/icon.svg"), "utf8");
  for (const id of ["blueberry-night", "claude-code-light", "cocoa-night", "sakura-latte", "claude-code-dark", "matcha-latte"]) {
    const theme = THEMES.find((item) => item.id === id);
    assert.ok(theme, `missing anchor theme ${id}`);
    for (const hex of [theme.colors.accent!, theme.colors.border, theme.colors.control, theme.colors.raised, theme.colors.background]) {
      assert.ok(iconSvg.includes(hex), `assets/icon.svg is missing ${id} swatch ${hex}`);
    }
  }

  assert.ok(manifest.media.length >= 1, "a theme listing needs a screenshot");
  for (const entry of manifest.media) {
    assert.match(entry, /^assets\/[\w.-]+\.png$/);
    const shot = pngSize(entry);
    assert.ok(shot.bytes <= 400 * 1024, `${entry} is ${Math.round(shot.bytes / 1024)} KB`);
    assert.ok(shot.width >= 1280, `${entry} is ${shot.width} px wide`);
  }
});

// name, icon and media fail to install on daemons before 0.11.0, and the SDK the code is
// typechecked against has to be the oldest Paseo the manifest admits.
test("the Paseo floor matches the SDK the code is checked against", () => {
  const floor = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.requirements.paseo)?.[1];
  assert.ok(floor, `unexpected range ${manifest.requirements.paseo}`);
  const [major, minor] = floor.split(".").map(Number) as [number, number];
  assert.ok(major > 0 || minor >= 11, `${floor} predates manifest name/icon/media`);
  assert.equal(pkg.devDependencies["@getpaseo/plugin"], floor);
});

// Paseo compiles the TypeScript itself and every SDK import is type-only, so a Git install
// needs no npm step at all.
test("installs without a build step or runtime dependencies", () => {
  assert.equal(manifest.build, undefined);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  const lock = json("package-lock.json");
  assert.equal(lock.packages[""].version, pkg.version);
  for (const [name, entry] of Object.entries<{ resolved?: string }>(lock.packages)) {
    if (entry.resolved) assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, name);
  }
});

test("the overview follows the registry's format", () => {
  const overview = readFileSync(join(root, "OVERVIEW.md"), "utf8");
  assert.ok(statSync(join(root, "LICENSE")).size > 0);
  assert.doesNotMatch(overview, /—/, "no em dashes");
  assert.doesNotMatch(overview, /paseo plugin (add|install)|npm (install|i) /i, "no install commands");
  assert.doesNotMatch(overview, /contribut/i, "no contributing section");
  assert.match(overview, /not affiliated with or endorsed by Anthropic/);
  assert.ok(overview.split(/\s+/).filter(Boolean).length <= 1000, "at most 1000 words");
});

// The live install keeps the id claude-theme; the public listing is terracotta-themes. The id names the folder users
// put their languages in, so the public export swaps in the file that says so (and the exported tree, which has no
// oss-export.json, checks that the swap happened).
test("the plugin id file matches the id the manifest publishes", () => {
  const idIn = (path: string) => /export const PLUGIN_ID = "([a-z][a-z0-9-]*)";/.exec(readFileSync(join(root, path), "utf8"))?.[1];
  assert.equal(idIn("shared/plugin-id.ts"), manifest.id);
  if (ossExport) {
    assert.deepEqual(ossExport.replace, { "shared/plugin-id.ts": "shared/plugin-id.oss.ts" });
    assert.equal(idIn("shared/plugin-id.oss.ts"), ossExport.manifest.id);
  }
});

// The settings screens are a lazy chunk built by the repository's `npm run build:chunks` and shipped prebuilt, so a
// Git install needs no build step; `npm run check:chunks` there rebuilds and compares.
test("the prebuilt screens chunk matches its manifest", () => {
  const code = readFileSync(join(root, "server/generated/ui-chunk.txt"), "utf8");
  const source = readFileSync(join(root, "shared/generated/ui-chunk-manifest.ts"), "utf8");
  const chunk = JSON.parse(/export const UI_CHUNK = (\{.*\}) as const;/.exec(source)![1]!);
  assert.deepEqual(chunk, {
    name: "ui",
    hash: createHash("sha256").update(code).digest("hex").slice(0, 16),
    api: 1,
    bytes: Buffer.byteLength(code),
  });
  assert.deepEqual(json("client-chunks.json"), [{ name: "ui", entry: "ui-chunk.client.tsx", manifest: "UI_CHUNK", api: 1 }]);
});
