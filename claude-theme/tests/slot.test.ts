import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { createSlot, FIRST_READ_GRACE_MS } from "../client/slot.ts";
import { customColors } from "../shared/custom.ts";
import { DEFAULT_PALETTE } from "../shared/generated/themes.ts";
import { CUSTOM_THEME_ID, DEFAULT_CUSTOM, type CustomParams } from "../shared/params.ts";
import { fakeClient, hostStore, hostValues, registry, settle } from "./support/host.ts";

const A: CustomParams = { appearance: "dark", surfaceHue: 40, surfaceTint: 50, accentHue: 200, accentVividness: 90 };
const B: CustomParams = { appearance: "light", surfaceHue: 300, surfaceTint: 30, accentHue: 20, accentVividness: 70 };
const C: CustomParams = { appearance: "dark", surfaceHue: 120, surfaceTint: 80, accentHue: 330, accentVividness: 100 };

function setup(t: TestContext, options: { stored?: CustomParams; cached?: unknown; hangReads?: boolean; failReads?: boolean; unreadable?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = hostStore(options.stored);
  store.hangReads = options.hangReads ?? false;
  store.failReads = options.failReads ?? false;
  store.unreadable = options.unreadable ?? false;
  const app = registry();
  const host = fakeClient(store, app);
  let name = "🎨 Custom";
  const cache = { value: options.cached, get: () => cache.value, set: (values: unknown) => void (cache.value = values) };
  const slot = createSlot(host.client, { name: () => name, cache });
  return {
    slot,
    store,
    app,
    cache,
    host,
    rename: (next: string) => {
      name = next;
    },
    async advance(ms: number) {
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}

const shows = (theme: PluginThemeContribution | undefined, params: CustomParams) => {
  assert.ok(theme, "no custom theme registered");
  assert.equal(theme.appearance, params.appearance);
  assert.deepEqual(theme.colors, customColors(params));
};

test("registers the host's saved theme under the fixed id once the first read answers", async (t) => {
  const { slot, app } = setup(t, { stored: A });
  assert.equal(app.current(), undefined, "waits for the host instead of flashing the default palette");
  await settle();
  shows(app.current(), A);
  assert.equal(app.current()!.id, CUSTOM_THEME_ID);
  assert.equal(app.current()!.name, "🎨 Custom");
  assert.deepEqual(slot.state().values, await hostValues(A));
  assert.equal(slot.state().revision, "r0");
  assert.equal(slot.state().error, null);
  slot.dispose();
});

test("the colours come from the host: the slot registers them as they are", async (t) => {
  const { slot, app } = setup(t, { stored: A });
  await settle();
  // The server computed them (`shared/settings.ts`); the stub carries no colour maths to compute its own.
  assert.deepEqual(app.current()!.colors, (slot.state().values as { colors: unknown }).colors);
  slot.dispose();
});

test("with a kept copy it registers at once, before the host answers, then follows the host's copy", async (t) => {
  const { slot, app, cache } = setup(t, { stored: B, cached: await hostValues(A) });
  shows(app.current(), A);
  await settle();
  shows(app.current(), B);
  assert.deepEqual(app.log, ["add 🎨 Custom", "remove", "add 🎨 Custom"]);
  assert.deepEqual(cache.value, await hostValues(B));
  slot.dispose();
});

test("a kept copy that is the host's copy registers once", async (t) => {
  const { slot, app } = setup(t, { stored: A, cached: await hostValues(A) });
  await settle();
  assert.deepEqual(app.log, ["add 🎨 Custom"], "a reload must not repaint the app once the host answers the same");
  slot.dispose();
});

test("a damaged kept copy is ignored", async (t) => {
  const values = await hostValues(A);
  for (const cached of [null, "x", 7, {}, { ...values, appearance: "sepia" }, { ...values, colors: { ...values.colors, ring: "#12345" } }, { ...values, colors: { ...values.colors, accent: 7 } }, { ...values, colors: null }]) {
    const { slot, app } = setup(t, { stored: A, cached, hangReads: true });
    assert.equal(app.current(), undefined, JSON.stringify(cached));
    slot.dispose();
    t.mock.timers.reset();
  }
});

test("an unanswered first read registers the default palette after the grace period", async (t) => {
  const { slot, app, advance } = setup(t, { stored: A, hangReads: true });
  await settle();
  assert.equal(app.current(), undefined);
  await advance(FIRST_READ_GRACE_MS - 1);
  assert.equal(app.current(), undefined);
  await advance(1);
  shows(app.current(), DEFAULT_CUSTOM);
  assert.deepEqual(app.current()!.colors, DEFAULT_PALETTE.colors);
  slot.dispose();
});

test("a failed read still registers the slot, says why, and retries", async (t) => {
  const { slot, app, store, advance } = setup(t, { stored: A, failReads: true });
  await settle();
  shows(app.current(), DEFAULT_CUSTOM);
  assert.match(slot.state().error!, /host unreachable/);
  await advance(1999);
  assert.equal(store.reads, 1);
  await advance(1);
  assert.equal(store.reads, 2, "retried after 2 s");
  store.failReads = false;
  await advance(10_000);
  shows(app.current(), A);
  assert.equal(slot.state().error, null);
  slot.dispose();
});

test("retries give up after three, and a change event reads again", async (t) => {
  const { slot, app, store, host, advance } = setup(t, { stored: A, failReads: true });
  await settle();
  for (const wait of [2000, 10_000, 30_000, 120_000]) await advance(wait);
  assert.equal(store.reads, 4);
  store.failReads = false;
  host.changed();
  await settle();
  shows(app.current(), A);
  slot.dispose();
});

test("a file this version cannot read keeps the theme on screen and says why", async (t) => {
  const { slot, app, store } = setup(t, { stored: A, unreadable: true, cached: await hostValues(B) });
  await settle();
  shows(app.current(), B);
  assert.match(slot.state().error!, /newer plugin version/);
  assert.equal(slot.state().revision, "r0");
  assert.deepEqual(store.writes, [], "reading alone never rewrites the file");
  slot.dispose();
});

test("a change saved on another device re-registers the theme here", async (t) => {
  const { slot, app, store, host } = setup(t, { stored: A });
  await settle();
  store.external(C);
  host.changed();
  await settle();
  shows(app.current(), C);
  assert.deepEqual(slot.state().values, await hostValues(C));
  slot.dispose();
});

test("a new language renames the theme, and only then", async (t) => {
  const { slot, app, rename } = setup(t, { stored: A });
  await settle();
  const before = app.log.length;
  slot.rename();
  assert.equal(app.log.length, before);
  rename("🎨 自定义");
  slot.rename();
  assert.equal(app.current()!.name, "🎨 自定义");
  shows(app.current(), A);
  slot.dispose();
});

test("a translation that breaks the app's name rules falls back to the English name", async (t) => {
  const { slot, app, rename } = setup(t, { stored: A });
  rename("  \u0007 ");
  await settle();
  assert.equal(app.current()!.name, "🎨 Custom");
  slot.dispose();
});

test("dispose removes the theme and stops following changes", async (t) => {
  const { slot, app, store, host, advance } = setup(t, { stored: A });
  await settle();
  assert.equal(host.observers.size, 1);
  slot.dispose();
  assert.equal(app.current(), undefined);
  assert.equal(host.observers.size, 0);
  const reads = store.reads;
  host.changed();
  slot.show(DEFAULT_PALETTE, true);
  await advance(60_000);
  assert.equal(store.reads, reads);
  assert.equal(app.current(), undefined);
});
