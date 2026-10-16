import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { PluginThemeContribution } from "@getpaseo/plugin";
import { liveThemeFor, settingsIo } from "../client/live-theme.ts";
import { APPLY_DELAY_MS, createSlot } from "../client/slot.ts";
import { customColors } from "../shared/custom.ts";
import { DEFAULT_CUSTOM, type CustomParams } from "../shared/params.ts";
import { fakeClient, hostStore, hostValues, registry, settle } from "./support/host.ts";

// The settings screen's side (lazy chunk): it shows edits through the resident slot and writes them to the host.

const A: CustomParams = { appearance: "dark", surfaceHue: 40, surfaceTint: 50, accentHue: 200, accentVividness: 90 };
const B: CustomParams = { appearance: "light", surfaceHue: 300, surfaceTint: 30, accentHue: 20, accentVividness: 70 };
const C: CustomParams = { appearance: "dark", surfaceHue: 120, surfaceTint: 80, accentHue: 330, accentVividness: 100 };

async function setup(t: TestContext, options: { stored?: CustomParams; unreadable?: boolean; failReads?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = hostStore(options.stored);
  store.unreadable = options.unreadable ?? false;
  store.failReads = options.failReads ?? false;
  const app = registry();
  const host = fakeClient(store, app);
  const cache = { value: undefined as unknown, get: () => cache.value, set: (values: unknown) => void (cache.value = values) };
  const slot = createSlot(host.client, { name: () => "🎨 Custom", cache });
  const live = liveThemeFor(slot, settingsIo(host.client));
  await settle();
  t.after(() => slot.dispose());
  return {
    slot,
    live,
    store,
    app,
    cache,
    host,
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

test("the screen starts from the host's copy", async (t) => {
  const { live } = await setup(t, { stored: A });
  assert.deepEqual(live.state().params, A);
  assert.deepEqual(live.state().saved, A);
  assert.equal(live.state().loading, false);
  assert.equal(live.state().saving, false);
  assert.equal(live.state().error, null);
  assert.equal(live.state(), live.state(), "an unchanged state is the same object, as React's store hook wants");
});

test("a burst of edits is applied to the app once, after the last one", async (t) => {
  // Applying the selected theme rebuilds Paseo's web views, so taps in quick succession must not each do it.
  const { live, app, advance } = await setup(t, { stored: A });
  const before = app.log.length;
  for (let hue = 41; hue <= 45; hue += 1) {
    void live.save({ ...A, surfaceHue: hue });
    await advance(APPLY_DELAY_MS / 2);
  }
  assert.equal(app.log.length, before, "nothing applied while the taps keep coming");
  assert.deepEqual(live.state().params, { ...A, surfaceHue: 45 }, "the screen shows each tap at once");
  await advance(APPLY_DELAY_MS);
  assert.deepEqual(app.log.slice(before), ["remove", "add 🎨 Custom"]);
  shows(app.current(), { ...A, surfaceHue: 45 });
});

test("letting go saves once, and the host's copy follows without repainting again", async (t) => {
  const { live, slot, app, store, cache, advance } = await setup(t, { stored: A });
  const before = app.log.length;
  const saved = await live.save(B);
  await advance(APPLY_DELAY_MS);
  assert.equal(saved, true);
  assert.deepEqual(store.writes, [B]);
  shows(app.current(), B);
  assert.deepEqual(app.log.slice(before), ["remove", "add 🎨 Custom"], "the host's answer matches what is shown");
  assert.deepEqual(live.state().saved, B);
  assert.equal(live.state().saving, false);
  assert.deepEqual(slot.state().values, await hostValues(B));
  assert.deepEqual(cache.value, await hostValues(B));
});

test("taps made while a write is on its way become one more write, with the last value", async (t) => {
  const { live, store } = await setup(t, { stored: A });
  store.hold();
  const first = live.save(B);
  await settle();
  void live.save({ ...B, surfaceHue: 305 });
  void live.save(C);
  store.held!.release();
  assert.equal(await first, true);
  assert.deepEqual(store.writes, [B, C]);
  assert.deepEqual(live.state().saved, C);
});

test("a change from elsewhere does not undo an edit that is still on its way", async (t) => {
  const { live, app, store, host, advance } = await setup(t, { stored: A });
  store.hold();
  const pending = live.save(B);
  store.external(C);
  host.changed();
  await settle();
  assert.deepEqual(live.state().params, B, "the user's edit stays on screen");
  await advance(APPLY_DELAY_MS);
  shows(app.current(), B);
  store.held!.release();
  assert.equal(await pending, true);
  await settle();
  shows(app.current(), B);
  assert.deepEqual(live.state().saved, B, "and goes on top of the other device's");
});

test("a change from elsewhere saved after the edit, before it is applied, wins", async (t) => {
  const { live, app, store, host, advance } = await setup(t, { stored: A });
  assert.equal(await live.save(B), true);
  store.external(C);
  host.changed();
  await settle();
  await advance(APPLY_DELAY_MS);
  shows(app.current(), C);
  assert.deepEqual(live.state().params, C);
});

test("a write that lost a race goes on top of the newer revision", async (t) => {
  const { live, store } = await setup(t, { stored: A });
  store.external(C);
  assert.equal(await live.save(B), true);
  assert.deepEqual(store.writes, [B, B]);
  assert.deepEqual(live.state().saved, B);
});

test("a file this version cannot read is reset before an explicit save, never silently", async (t) => {
  const { live, store } = await setup(t, { stored: A, unreadable: true });
  assert.equal(live.state().error?.kind, "read");
  assert.deepEqual(store.writes, [], "reading alone never rewrites the file");
  assert.equal(await live.save(B), true);
  assert.equal(store.resets, 1);
  assert.deepEqual(live.state().saved, B);
  assert.equal(live.state().error, null);
});

test("a failed save shows the host's copy again at once and says why", async (t) => {
  const { live, app, store, advance } = await setup(t, { stored: A });
  store.failWrites = true;
  assert.equal(await live.save(B), false);
  shows(app.current(), A);
  await advance(APPLY_DELAY_MS);
  shows(app.current(), A);
  assert.deepEqual(live.state().params, A);
  assert.equal(live.state().error?.kind, "save");
  assert.match(live.state().error!.message, /socket closed/);
});

test("a failed edit does not cancel the retry of a failed read", async (t) => {
  const { live, app, store, advance } = await setup(t, { stored: A, failReads: true });
  shows(app.current(), DEFAULT_CUSTOM);
  store.failWrites = true;
  assert.equal(await live.save(B), false);
  store.failReads = false;
  await advance(2000);
  shows(app.current(), A);
  assert.deepEqual(live.state().params, A);
});

test("one writer per slot, so a write survives the settings page being rebuilt", async (t) => {
  const { slot, live, host } = await setup(t, { stored: A });
  assert.equal(liveThemeFor(slot, settingsIo(host.client)), live);
});
