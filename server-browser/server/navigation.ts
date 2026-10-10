/**
 * One set of address rules for the panel, the browser Agent and restored tabs.
 * Link-local and cloud metadata addresses are refused here and again inside Chromium (see blockedHostResolverRules),
 * so pages cannot reach them by script, redirect, frame or form either. Host names that only resolve to such
 * addresses through DNS are not recognised.
 */
const BLOCKED_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);
const BLOCKED_IPV6 = new Set(['fd00:ec2::254', '::ffff:6464:64c8']);

/** hostname as URL parses it: IPv4 in dotted form, IPv6 in brackets, names in lower case. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_NAMES.has(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || host === '100.100.100.200') return true;
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const ipv6 = host.slice(1, -1);
  if (BLOCKED_IPV6.has(ipv6)) return true;
  // IPv4-mapped and IPv4-compatible forms of 169.254.0.0/16 (URL writes ::ffff:169.254.1.2 as ::ffff:a9fe:102).
  if (/^::(?:ffff:)?a9fe:[0-9a-f]{1,4}$/.test(ipv6)) return true;
  // fe80::/10, link-local.
  const first = ipv6.split(':')[0];
  return /^[0-9a-f]{1,4}$/.test(first) && (Number.parseInt(first, 16) & 0xffc0) === 0xfe80;
}

/** Chromium --host-resolver-rules that make the same addresses fail to resolve for every request the browser makes. */
export function blockedHostResolverRules(): string {
  return [
    '169.254.*', '100.100.100.200', '::ffff:a9fe:*', '::a9fe:*', '::ffff:6464:64c8', 'fe8?:*', 'fe9?:*', 'fea?:*', 'feb?:*', 'fd00:ec2::254',
    ...[...BLOCKED_NAMES].flatMap(name => [name, `${name}.`]),
  ].map(host => `MAP ${host} ~NOTFOUND`).join(', ');
}

export function normalizeNavigationUrl(value: string): string {
  const trimmed = value.trim(); if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) throw new Error('请输入有效的网页地址。');
  const explicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed), hostWithPort = /^(localhost|[\w.-]+):\d+(?:[/?#]|$)/i.test(trimmed);
  const url = new URL(explicitScheme && !hostWithPort ? trimmed : `https://${trimmed}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 HTTP 或 HTTPS 网页。');
  if (url.username || url.password) throw new Error('请在网页内登录，不要在地址中填写密码。');
  if (isBlockedHost(url.hostname)) throw new Error('这是链路本地或云服务器元数据地址，共享浏览器不会打开。');
  return url.toString();
}

/**
 * Query parameters that usually carry a one-time or secret value: OAuth codes and state, tokens, signatures,
 * tickets, session ids, one-time passwords and magic links. Matched on the lower-case name with "-" read as "_".
 */
const SECRET_NAMES = new Set(['code', 'state', 'token', 'auth', 'key', 'sig', 'signature', 'ticket', 'session', 'sid', 'otp', 'magic', 'password', 'passwd', 'pwd', 'secret', 'nonce', 'jwt']);
const SECRET_PARTS = /token|secret|passw|signature|credential|session|saml|magic|verifier|api_?key|access_?key|private_?key|auth_?code|otp_|_otp/;
export function isSecretParameter(name: string): boolean {
  const key = name.toLowerCase().replace(/-/g, '_');
  return SECRET_NAMES.has(key) || SECRET_PARTS.test(key);
}

/**
 * The address a tab may be saved and reopened with: HTTP(S) only, no credentials, no fragment, and no query
 * parameter that looks like a one-time credential. Other query parameters stay so ordinary pages reopen as they were.
 */
export function restorableUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isBlockedHost(url.hostname)) return null;
  url.hash = '';
  // Filter the raw query so the parameters that stay keep their exact encoding.
  const kept = url.search.slice(1).split('&').filter(part => {
    const raw = part.split('=')[0];
    let name = raw;
    try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { /* keep the raw name */ }
    return !isSecretParameter(name);
  });
  url.search = kept.some(Boolean) ? `?${kept.join('&')}` : '';
  return url.toString();
}
