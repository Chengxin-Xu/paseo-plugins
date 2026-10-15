import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// The registry installs exactly what is committed: a Git install runs the manifest build with production
// dependencies only, so the CLI bundle must not need anything from devDependencies.
const root = join(__dirname, "..");
const json = async (name: string) => JSON.parse(await readFile(join(root, name), "utf8"));
const packageOf = (input: string) => /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? null;

describe("packaging", () => {
  it("installs production dependencies from the lockfile, then builds the CLI", async () => {
    const manifest = await json("paseo-plugin.json"), pkg = await json("package.json");
    expect(manifest.build).toEqual([["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], ["npm", "run", "build"]]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["esbuild", "zod"]);
    expect(pkg.scripts.build).toMatch(/^esbuild server\/cli\.ts --bundle .*--outfile=bin\/notes\.mjs/);
  });

  it("bundles the CLI from zod and local sources only", async () => {
    const result = await build({ absWorkingDir: root, entryPoints: ["server/cli.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: "bin/notes.mjs", write: false, metafile: true, logLevel: "silent" });
    const allInputs = Object.keys(result.metafile.inputs);
    const languageInputs = allInputs.filter(input => /^(server\/locales\.ts|shared\/(i18n\.ts|text\.ts|locales\/))/.test(input));
    expect(languageInputs.sort()).toEqual(["server/locales.ts", "shared/i18n.ts", "shared/locales/en.json", "shared/locales/kit/en.json", "shared/locales/kit/zh-CN.json", "shared/locales/zh-CN.json", "shared/text.ts"]);
    const inputs = allInputs.filter(input => !languageInputs.includes(input));
    expect(inputs.filter(input => packageOf(input) === null).sort()).toEqual(["server/cli.ts", "server/store.ts", "shared/schema.ts"]);
    expect([...new Set(inputs.map(packageOf).filter(Boolean))]).toEqual(["zod"]);
  });

  it("pins the Paseo SDK to the manifest minimum and resolves every package from the public registry", async () => {
    const manifest = await json("paseo-plugin.json"), pkg = await json("package.json"), lock = await json("package-lock.json");
    const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.requirements.paseo)?.[1];
    expect(minimum).toBe("0.11.1");
    for (const name of ["@getpaseo/plugin", "@getpaseo/client", "@getpaseo/protocol"]) {
      expect(pkg.devDependencies[name]).toBe(minimum);
      expect(lock.packages[`node_modules/${name}`].version).toBe(minimum);
    }
    expect([lock.version, lock.packages[""].version]).toEqual([pkg.version, pkg.version]);
    const foreign = Object.entries(lock.packages as Record<string, { resolved?: string }>).filter(([, entry]) => entry.resolved && !entry.resolved.startsWith("https://registry.npmjs.org/"));
    expect(foreign).toEqual([]);
  });

  it("ships the icon and screenshots the manifest lists", async () => {
    const manifest = await json("paseo-plugin.json");
    const icon = await readFile(join(root, manifest.icon));
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20)]).toEqual([512, 512]);
    expect(manifest.media.length).toBeGreaterThan(0);
    for (const file of manifest.media) {
      expect(file).toMatch(/^assets\/[\w-]+\.png$/);
      expect((await stat(join(root, file))).size).toBeLessThan(400_000);
    }
  });
});
