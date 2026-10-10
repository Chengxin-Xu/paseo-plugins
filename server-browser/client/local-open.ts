/** Only HTTP(S) pages can be opened on the viewer's own device; URL credentials are never forwarded. */
export function deviceOpenableUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = ''; url.password = '';
    return url.toString();
  } catch { return null; }
}
