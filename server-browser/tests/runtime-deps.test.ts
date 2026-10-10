import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const json = async (file: string) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));

test('the host runtime ships an exact, locked dependency tree from the public npm registry', async () => {
  const pkg = await json('runtime-deps/package.json');
  const lock = await json('runtime-deps/package-lock.json');
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned to one version`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} is locked at ${version}`);
  }
  const entries = Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string }>).filter(([key]) => key);
  for (const [key, entry] of entries) {
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${key} resolves from registry.npmjs.org`);
    assert.match(entry.integrity ?? '', /^sha512-/, `${key} carries an integrity hash`);
  }
  // The plugin loads these from the runtime directory, so they must be part of the locked tree too.
  for (const name of ['playwright', 'playwright-core', 'jsdom', '@mozilla/readability', 'turndown', '@playwright/mcp']) {
    assert.ok(lock.packages[`node_modules/${name}`], `${name} is locked`);
  }
});

test('setup-runtime installs the shipped lockfile with npm ci and install scripts disabled', async () => {
  const script = await readFile(new URL('../scripts/setup-runtime.mjs', import.meta.url), 'utf8');
  assert.match(script, /for\(const file of \['package\.json','package-lock\.json'\]\)/);
  assert.match(script, /spawn\('npm',\['ci','--ignore-scripts','--no-audit','--no-fund'\]/);
  assert.doesNotMatch(script, /'install'/);
});
