// The fixture preview's port, shared by scripts/preview.mjs (which serves it) and tests/playwright.config.mjs (which
// points the browser at it). Set PROJECT_NOTES_PREVIEW_PORT when 4693 is taken or two checkouts run side by side.
export const DEFAULT_PREVIEW_PORT = 4693;

export function previewPort(env = process.env) {
  const raw = env.PROJECT_NOTES_PREVIEW_PORT?.trim();
  if (!raw) return DEFAULT_PREVIEW_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new Error(`PROJECT_NOTES_PREVIEW_PORT must be a port number from 1 to 65535, not "${raw}".`);
  return port;
}
