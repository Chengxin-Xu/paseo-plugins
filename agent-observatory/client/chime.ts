import { AppState } from "react-native";
import type { AttentionState } from "../shared/attention-rpc";
import { deviceMuted } from "./chime-device";

/**
 * 提示音 (2.17, after Herald's idea): one short sound when 需要处理 gets a new entry, through the host's `playAudio`. Resident, so it
 * is kept small: the sounds are synthesised (a few kilobytes of WAV) only when one is about to play, then kept. Each event
 * sounds once per device (an app session: what was there when the app started, or when the chime was turned on, never
 * sounds); one turn sounds at most once in 15 seconds; never while this device is muted, in its quiet hours or in the
 * background. The server decides which kinds sound and whether subagents do (shared/alerts.ts).
 */
type Kind = "question" | "approval" | "quota" | "error" | "done";
type Play = (source: { base64: string; mimeType: string }) => Promise<void>;
/** Several new at once: the most urgent kind sounds. */
const URGENCY: Kind[] = ["approval", "question", "error", "quota", "done"];
/** Notes as [hertz, start, length] in seconds: a rising question, a two-tone call to approve, a falling limit, a low buzz, a soft bell. */
const NOTES: Record<Kind, number[]> = {
  question: [659, 0, 0.14, 880, 0.12, 0.22],
  approval: [988, 0, 0.13, 740, 0.15, 0.24],
  quota: [784, 0, 0.13, 587, 0.12, 0.13, 440, 0.24, 0.24],
  error: [233, 0, 0.11, 233, 0.16, 0.16],
  done: [1047, 0, 0.12, 1568, 0.08, 0.3],
};
const RATE = 16_000, TURN_MS = 15_000, KEEP = 400;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A 16-bit mono WAV of the kind's notes, base64-encoded (what `playAudio` takes). */
export function chimeWav(kind: Kind): string {
  const notes = NOTES[kind], buzz = kind === "error";
  let end = 0;
  for (let index = 0; index < notes.length; index += 3) end = Math.max(end, notes[index + 1]! + notes[index + 2]!);
  const count = Math.ceil((end + 0.02) * RATE), bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer);
  // The 44-byte header as little-endian words: "RIFF", size, "WAVE", "fmt ", 16, PCM + mono, rate, bytes a second, 2-byte
  // frames + 16 bits, "data", data size.
  [0x46464952, 36 + count * 2, 0x45564157, 0x20746d66, 16, 0x10001, RATE, RATE * 2, 0x100002, 0x61746164, count * 2].forEach((word, index) => view.setUint32(index * 4, word, true));
  for (let sample = 0; sample < count; sample++) {
    const time = sample / RATE;
    let value = 0;
    for (let index = 0; index < notes.length; index += 3) {
      const at = time - notes[index + 1]!, length = notes[index + 2]!;
      if (at < 0 || at > length) continue;
      const phase = 2 * Math.PI * notes[index]! * at, level = Math.min(1, at / 0.005, (length - at) / 0.02) * Math.exp(-at * (buzz ? 8 : 5));
      value += level * (buzz ? Math.sin(phase) + Math.sin(3 * phase) / 3 + Math.sin(5 * phase) / 5 : Math.sin(phase) + Math.sin(2 * phase) / 4);
    }
    view.setInt16(44 + sample * 2, Math.round(Math.max(-1, Math.min(1, value * 0.42)) * 32_767), true);
  }
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!, b = bytes[index + 1], c = bytes[index + 2], bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    parts.push(LETTERS[(bits >> 18) & 63]! + LETTERS[(bits >> 12) & 63]! + (b === undefined ? "=" : LETTERS[(bits >> 6) & 63]!) + (c === undefined ? "=" : LETTERS[bits & 63]!));
  }
  return parts.join("");
}

const sounds: Partial<Record<Kind, string>> = {};
/** Plays one kind now (the settings' 试听 too); a failure (no user gesture yet on the web, no audio) stays silent. */
export function playChime(play: Play, kind: Kind): void {
  const base64 = sounds[kind] ?? (sounds[kind] = chimeWav(kind));
  void play({ base64, mimeType: "audio/wav" }).catch(() => {});
}

/** Inside quiet hours ("HH:MM" to "HH:MM" on this device's clock; a start after the end runs overnight). */
export function inQuietHours(quiet: { from: string; to: string } | null | undefined, at: Date): boolean {
  if (!quiet) return false;
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  const now = at.getHours() * 60 + at.getMinutes(), start = minutes(quiet.from), stop = minutes(quiet.to);
  return start < stop ? now >= start && now < stop : start > stop ? now >= start || now < stop : false;
}

/** What one host's events did on this device in this app session: seen ids, each turn's last sound, whether it is armed. */
interface Memory { seen: Map<string, number>; turns: Map<string, number>; armed: boolean }
const session = globalThis as { __agentObservatoryChime?: Record<string, Memory> };

/**
 * The chime of one registration: `onRead` after every full read of a host's 需要处理 summary. While the chime is on it also keeps
 * that host's summary polling (20 s, foreground only, as the badge does) when no badge is on screen.
 */
export function createChime(play: Play, options: { now?: () => number; active?: () => boolean; muted?: () => boolean } = {}) {
  const now = options.now ?? Date.now, muted = options.muted ?? deviceMuted;
  const active = options.active ?? (() => AppState.currentState !== "background" && AppState.currentState !== "inactive");
  const memories = session.__agentObservatoryChime ?? (session.__agentObservatoryChime = {});
  const held = new Map<string, () => void>();
  return {
    onRead(hostId: string, state: AttentionState, store?: { subscribe(listener: () => void): () => void }): void {
      const memory = memories[hostId] ?? (memories[hostId] = { seen: new Map(), turns: new Map(), armed: false });
      const chime = state.chime;
      if (!chime) { memory.armed = false; held.get(hostId)?.(); held.delete(hostId); return; }
      if (store && !held.has(hostId)) held.set(hostId, store.subscribe(() => {}));
      const at = now(), fresh = chime.events.filter(event => !memory.seen.has(event.id));
      for (const event of chime.events) memory.seen.set(event.id, at);
      while (memory.seen.size > KEEP) memory.seen.delete(memory.seen.keys().next().value!);
      // What is there when the chime starts listening is not news.
      if (!memory.armed) { memory.armed = true; return; }
      if (!fresh.length || muted() || !active() || inQuietHours(chime.quiet, new Date(at))) return;
      const turnOf = (event: { id: string; turn: string }) => `${event.id.slice(0, event.id.indexOf("|"))}|${event.turn}`;
      const due = fresh.filter(event => at - (memory.turns.get(turnOf(event)) ?? Number.NEGATIVE_INFINITY) >= TURN_MS);
      const kind = URGENCY.find(candidate => due.some(event => event.kind === candidate));
      if (!kind) return;
      for (const event of due) memory.turns.set(turnOf(event), at);
      while (memory.turns.size > KEEP) memory.turns.delete(memory.turns.keys().next().value!);
      playChime(play, kind);
    },
    dispose(): void { for (const release of held.values()) release(); held.clear(); },
  };
}
