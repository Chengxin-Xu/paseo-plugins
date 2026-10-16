import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DEFAULT_PALETTE } from "../shared/generated/themes.ts";
import { CUSTOM_SETTINGS_ID, customContribution, customThemeRpc, paletteKey, readPalette, type CustomPalette } from "../shared/params.ts";
import { watchSetting } from "./sync.ts";

/**
 * The custom theme slot on this client. It registers the custom palette with the host under the fixed id, and when the
 * palette changes it removes that theme and adds the new one (Paseo rejects a second theme with the same id while the
 * first is registered). The app's theme catalog follows the registry at once, and when the custom theme is the one
 * selected, Paseo applies the new colours straight away, which is what makes the slot live.
 *
 * The parameters live in the host's settings, so every device of that host shows the same theme: the slot reads them
 * at start and follows changes made on any device. The server computes the palette whenever the setting is read or
 * written (`shared/settings.ts`), so the slot only registers ready colours: this file ships with every connection, the
 * colour maths only with the settings screen. That screen (`live-theme.ts`, lazy chunk) writes the user's edits and
 * shows them through `show`, holding the slot while a write is on its way.
 *
 * Applying a changed theme is not free: the Paseo 0.11.1 web app rebuilds its whole view tree when the selected theme's
 * colours change (switching between two fixed themes does the same), which ends any gesture in progress and resets
 * scroll positions. So a burst of edits (taps on a stepper) is applied once, `APPLY_DELAY_MS` after the last one.
 */

/** The host's last copy, so a reconnect (and a web reload) registers the slot before the first read returns. */
export interface ValuesCache {
  get(): unknown;
  set(values: unknown): void;
}

export interface SlotOptions {
  /** The theme's display name in the language the plugin speaks now. */
  name(): string;
  cache?: ValuesCache;
}

export interface SlotState {
  /** The setting as the host last returned it (the parameters and their computed `colors`), else the kept copy. */
  readonly values: unknown;
  /** The revision of the host's copy; null until the host answers. */
  readonly revision: string | null;
  /** Why the host's copy could not be read, if it could not. */
  readonly error: string | null;
}

export interface Slot {
  state(): SlotState;
  /** The settings screen's writer (one per slot, `live-theme.ts`) hears every change of `state()` here. */
  listen(listener: () => void): void;
  /** Takes the copy the host returned for a write. */
  accept(revision: string, values: unknown): void;
  /** Shows `palette` (the host's copy when left out) now, or with `later` once calls have paused for `APPLY_DELAY_MS`. */
  show(palette?: CustomPalette, later?: boolean): void;
  /** While held (an edit is on its way), the host's copies are kept but not shown; letting go shows the latest. */
  hold(on: boolean): void;
  /** Registers the theme again if its name changed (the plugin's language changed). */
  rename(): void;
  dispose(): void;
}

/** Taps closer together than this are applied to the app once. */
export const APPLY_DELAY_MS = 250;
/** Without a kept copy the slot waits this long for the host's answer before showing the default palette. */
export const FIRST_READ_GRACE_MS = 4000;
const RETRY_MS = [2000, 10_000, 30_000];

export const errorText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error ?? "").slice(0, 200);

export function createSlot(client: PluginClientContext, options: SlotOptions): Slot {
  let listener: (() => void) | undefined;
  let cached: unknown = null;
  try {
    cached = options.cache?.get();
  } catch {
    // A broken cache only costs the wait for the host.
  }
  // A damaged copy must not paint a theme nobody chose.
  let state: SlotState = { values: readPalette(cached) ? cached : null, revision: null, error: null };
  let shown: { key: string; palette: CustomPalette; remove(): unknown } | null = null;
  let disposed = false;
  let held = false;
  let reads = 0;
  let failures = 0;
  /** An edit waiting to be applied. */
  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  /** The first read's grace period, later the retry after a failed read. */
  let waitTimer: ReturnType<typeof setTimeout> | undefined;

  const register = (palette: CustomPalette) => {
    const name = options.name();
    const key = paletteKey(palette) + name;
    if (disposed || shown?.key === key) return;
    const previous = shown;
    shown = null;
    try {
      // Remove first: the host refuses a second theme under an id that is still registered.
      previous?.remove();
      shown = { key, palette, remove: client.addTheme(customContribution(palette, name)) };
    } catch (error) {
      console.warn("[custom theme] cannot register the theme", error);
    }
  };
  /** Shows the host's copy, unless an edit is on its way or about to be applied. */
  const sync = () => {
    if (!held && applyTimer === undefined) register(readPalette(state.values) ?? DEFAULT_PALETTE);
  };
  /** News from the host (an answer, or none): ends the wait for it. */
  const update = (patch: Partial<SlotState>) => {
    clearTimeout(waitTimer);
    state = { ...state, ...patch };
    sync();
    listener?.();
  };
  const accept = (revision: string, values: unknown) => {
    try {
      if (readPalette(values)) options.cache?.set(values);
    } catch {
      // Full or blocked storage only costs the next reload the wait for the host.
    }
    update({ values, revision, error: null });
  };

  const refresh = async () => {
    const ticket = ++reads;
    try {
      const result = await client.rpc(customThemeRpc.read, {});
      if (disposed || ticket !== reads) return;
      failures = 0;
      if (result.status === "ready") accept(result.revision, result.values);
      // A file this schema cannot take (a newer plugin's): keep the theme on screen, say why.
      else update({ revision: result.revision, error: result.error });
    } catch (error) {
      if (disposed || ticket !== reads) return;
      // The slot must exist even when the host does not answer: the user may have selected it.
      update({ error: errorText(error) });
      if (failures < RETRY_MS.length) waitTimer = setTimeout(refresh, RETRY_MS[failures++]);
    }
  };

  const stopWatching = watchSetting(client, CUSTOM_SETTINGS_ID, () => void refresh());
  if (state.values) sync();
  else waitTimer = setTimeout(() => shown || sync(), FIRST_READ_GRACE_MS);
  void refresh();

  return {
    state: () => state,
    listen(next) {
      listener = next;
    },
    accept,
    show(palette, later) {
      if (disposed) return;
      clearTimeout(applyTimer);
      applyTimer = undefined;
      const next = palette ?? readPalette(state.values) ?? DEFAULT_PALETTE;
      if (!later) return register(next);
      applyTimer = setTimeout(() => {
        applyTimer = undefined;
        // Once the edit is saved, the host's copy is it, or a newer one from another device that then wins.
        if (held) register(next);
        else sync();
      }, APPLY_DELAY_MS);
    },
    hold(on) {
      held = on;
      if (!on) sync();
    },
    rename() {
      if (shown && applyTimer === undefined) register(shown.palette);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(applyTimer);
      clearTimeout(waitTimer);
      stopWatching();
      listener = undefined;
      try {
        shown?.remove();
      } catch {
        // The host is unloading the plugin anyway.
      }
      shown = null;
    },
  };
}
