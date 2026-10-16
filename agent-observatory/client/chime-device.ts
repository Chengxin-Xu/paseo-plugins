/**
 * 这台设备静音 for the chime (2.17): the device's own choice, not a host setting. Web and desktop keep it in localStorage; the
 * phone app has no storage a plugin can use, so there it lasts until the app restarts (the app session's global). Shared by
 * the resident chime and the settings in the UI chunk, two bundles that meet only here.
 */
const STORAGE = "agent-observatory.chime-muted";
type Holder = { __agentObservatoryChimeMuted?: boolean; localStorage?: { getItem(name: string): string | null; setItem(name: string, value: string): void; removeItem(name: string): void } };
const holder = globalThis as Holder;

/** Whether this device keeps the chime quiet. */
export function deviceMuted(): boolean {
  try { const stored = holder.localStorage?.getItem(STORAGE); if (stored !== undefined && stored !== null) return stored === "1"; } catch { /* storage refused */ }
  return holder.__agentObservatoryChimeMuted === true;
}
/** Mutes or unmutes this device; true when it is kept across restarts (web, desktop), false for this app session only. */
export function setDeviceMuted(muted: boolean): boolean {
  holder.__agentObservatoryChimeMuted = muted;
  try {
    if (!holder.localStorage) return false;
    if (muted) holder.localStorage.setItem(STORAGE, "1"); else holder.localStorage.removeItem(STORAGE);
    return true;
  } catch { return false; }
}
/** Whether this device can keep the choice (web and desktop do; the phone app cannot). */
export function deviceMuteKept(): boolean {
  try { return !!holder.localStorage && typeof holder.localStorage.getItem === "function"; } catch { return false; }
}
