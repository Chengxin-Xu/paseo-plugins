import type { PluginClientContext } from "@getpaseo/plugin/client";
import { customPalette } from "../shared/custom.ts";
import { customThemeRpc, DEFAULT_CUSTOM, normalizeParams, type CustomParams } from "../shared/params.ts";
import { errorText, type Slot, type SlotState } from "./slot.ts";

/**
 * The settings screen's side of the custom theme (lazy chunk): it shows each edit in the app through the resident slot
 * (`slot.ts`), computing the palette with the recipe, and writes it to the host's settings. Writes go one at a time;
 * edits made meanwhile replace the queued one, so a burst of taps costs one write per reply. While a write is on its
 * way the slot is held, so a read from before the edit cannot undo it on screen. A failed write shows the host's copy
 * again and says why.
 *
 * One per slot (`liveThemeFor`): Paseo rebuilds the settings page when the selected theme changes, and a write started
 * before the rebuild must still finish and report to the page that replaces it.
 */

export type WriteResult =
  | { readonly status: "saved"; readonly revision: string; readonly values: unknown }
  | { readonly status: "conflict"; readonly error: string }
  | { readonly status: "invalid"; readonly error: string };

export interface SaveIo {
  read(): Promise<{ readonly revision: string }>;
  write(input: { revision: string; values: CustomParams }): Promise<WriteResult>;
  /** Clears a stored file the schema cannot take (a newer plugin's, or a broken one) before an explicit save. */
  reset(input: { revision: string }): Promise<WriteResult>;
}

export interface LiveState {
  /** The parameters on screen: the user's latest edit, else the host's copy. */
  readonly params: CustomParams;
  /** The host's copy as last read or written (or kept from the last connection); null before any. */
  readonly saved: CustomParams | null;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: { readonly kind: "read" | "save"; readonly message: string } | null;
}

export interface LiveTheme {
  state(): LiveState;
  subscribe(listener: () => void): () => void;
  /** Shows `params` (applied to the app once edits pause) and writes them to the host. Resolves false when that fails. */
  save(params: CustomParams): Promise<boolean>;
}

/** The setting's calls as the settings screen makes them. */
export function settingsIo(client: PluginClientContext): SaveIo {
  return {
    read: () => client.rpc(customThemeRpc.read, {}),
    write: (input) => client.rpc(customThemeRpc.write, { revision: input.revision, values: { ...input.values } }),
    reset: (input) => client.rpc(customThemeRpc.reset, input),
  };
}

const models = new WeakMap<Slot, LiveTheme>();

export function liveThemeFor(slot: Slot, io: SaveIo): LiveTheme {
  let model = models.get(slot);
  if (!model) models.set(slot, (model = createLiveTheme(slot, io)));
  return model;
}

export function createLiveTheme(slot: Slot, io: SaveIo): LiveTheme {
  const listeners = new Set<() => void>();
  let edit: CustomParams | null = null;
  let saving = false;
  let saveError: string | null = null;
  let writing: Promise<boolean> | null = null;
  let queued: CustomParams | null = null;
  let version = 0;
  let seen: { host: SlotState; version: number; state: LiveState } | null = null;

  const emit = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  const changed = () => {
    version += 1;
    emit();
  };
  // The host's copy changed (a read, another device, a write's answer): the state is derived from it.
  slot.listen(emit);

  const state = (): LiveState => {
    const host = slot.state();
    if (seen?.host === host && seen.version === version) return seen.state;
    const saved = host.values === null || host.values === undefined ? null : normalizeParams(host.values);
    // Before the host's first answer there is neither a revision nor a reason it failed.
    const loading = host.revision === null && host.error === null;
    const error = saveError !== null ? { kind: "save" as const, message: saveError } : host.error !== null ? { kind: "read" as const, message: host.error } : null;
    seen = { host, version, state: { params: edit ?? saved ?? DEFAULT_CUSTOM, saved, loading, saving, error } };
    return seen.state;
  };

  const writeOnce = async (values: CustomParams): Promise<boolean> => {
    try {
      let revision = slot.state().revision ?? (await io.read()).revision;
      let result = await io.write({ revision, values });
      if (result.status === "conflict") {
        // Another device saved in between. This device's edit is the newer intent, so it goes on top.
        revision = (await io.read()).revision;
        result = await io.write({ revision, values });
      }
      if (result.status === "invalid") {
        const cleared = await io.reset({ revision });
        if (cleared.status === "saved") result = await io.write({ revision: cleared.revision, values });
      }
      if (result.status !== "saved") {
        saveError = result.error;
        return false;
      }
      saveError = null;
      slot.accept(result.revision, result.values);
      return true;
    } catch (error) {
      saveError = errorText(error);
      return false;
    }
  };

  const drain = async (): Promise<boolean> => {
    // Let `save` finish taking note of this run before a listener can call back into it.
    await Promise.resolve();
    let ok = true;
    while (queued) {
      const values = queued;
      queued = null;
      ok = await writeOnce(values);
    }
    writing = null;
    edit = null;
    saving = false;
    slot.hold(false);
    // Show the host's copy again rather than a theme no other device has.
    if (!ok) slot.show();
    changed();
    return ok;
  };

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    save(params) {
      const next = normalizeParams(params);
      queued = next;
      edit = next;
      saving = true;
      slot.hold(true);
      slot.show(customPalette(next), true);
      const running = writing ?? (writing = drain());
      changed();
      return running;
    },
  };
}
