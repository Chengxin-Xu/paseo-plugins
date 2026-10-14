import { readPiNotice } from "./shared/pi-notice";

/**
 * 0.6.0-local.5: the Pi notice reader (shared/pi-notice.ts) in a lazy chunk of its own. Only Pi and OMP Agents send these
 * notices, so the resident timeline leaves it out and client/transform.ts loads it when the first one is drawn.
 */
export default function chunk() {
  return { api: 1, createSurfaces() { return { readPiNotice }; } };
}
