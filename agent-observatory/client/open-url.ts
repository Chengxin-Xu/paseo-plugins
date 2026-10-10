import { Linking } from "react-native";

/**
 * Opens an http(s) link (a merge or pull request) in the user's browser. On the desktop app `Linking.openURL` would
 * open a bare child frame, so the preload opener Paseo's own links use is preferred there.
 * Adapted from panrafal/paseo-plugins schedule-runs (MIT).
 */
interface DesktopOpener { readonly opener?: { readonly openUrl?: (url: string) => Promise<void> } }
export function isHttpUrl(url: string): boolean {
  try { const protocol = new URL(url).protocol; return protocol === "http:" || protocol === "https:"; } catch { return false; }
}
export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) throw new Error("只能打开 http(s) 链接");
  const openUrl = (globalThis as { paseoDesktop?: DesktopOpener }).paseoDesktop?.opener?.openUrl;
  if (typeof openUrl === "function") {
    try { await openUrl(url); return; } catch { /* fall back to Linking */ }
  }
  await Linking.openURL(url);
}
