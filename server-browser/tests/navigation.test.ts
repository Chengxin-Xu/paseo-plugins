import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedHostResolverRules, isBlockedHost, isSecretParameter, normalizeNavigationUrl, restorableUrl } from '../server/navigation';

test('navigation refuses link-local and cloud metadata addresses in every spelling URL parsing accepts', () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/', '169.254.169.254', 'http://169.254.0.1:9/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://169.254.43518/',
    'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fd00:ec2::254]/latest/', 'http://[fe80::1]/', 'http://[febf::1]/',
    'http://100.100.100.200/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://METADATA.GOOGLE.INTERNAL./', 'metadata.goog',
  ]) assert.throws(() => normalizeNavigationUrl(url), /链路本地或云服务器元数据/, url);
  for (const url of ['http://127.0.0.1:6767/', 'https://example.com/', 'http://[fec0::1]/', 'http://[::1]:8080/', 'http://169.255.1.1/', 'http://100.100.100.201/', 'https://metadata.example.com/'])
    assert.doesNotThrow(() => normalizeNavigationUrl(url), url);
  assert.equal(isBlockedHost('[::ffff:a9fe:1]'), true);
  assert.equal(isBlockedHost('[fe7f::1]'), false);
});

test('the same addresses become Chromium host-resolver rules', () => {
  const rules = blockedHostResolverRules();
  for (const host of ['169.254.*', '::ffff:a9fe:*', 'fd00:ec2::254', 'fe8?:*', 'feb?:*', '100.100.100.200', 'metadata.google.internal', 'metadata.google.internal.', 'metadata.goog'])
    assert(rules.includes(`MAP ${host} ~NOTFOUND`), host);
  assert(!/[\s]{2}|,,/.test(rules));
});

test('restored tab addresses lose fragments and one-time credentials but keep ordinary query parameters', () => {
  assert.equal(restorableUrl('https://app.example.com/callback?code=abc123&state=xyz&session_state=s1#access_token=t'), 'https://app.example.com/callback');
  assert.equal(restorableUrl('https://shop.example.com/search?q=red%20shoes&page=2&sort=price#results'), 'https://shop.example.com/search?q=red%20shoes&page=2&sort=price');
  assert.equal(restorableUrl('https://files.example.com/report.pdf?X-Amz-Credential=c&X-Amz-Signature=s&X-Amz-Expires=60&download=1'), 'https://files.example.com/report.pdf?X-Amz-Expires=60&download=1');
  assert.equal(restorableUrl('https://example.com/login?token=t&magic=m&otp=1&ticket=T&sid=9&id_token=x&access_token=y&refresh_token=z&api_key=k&key=k2&sig=s&password=p&lang=en'), 'https://example.com/login?lang=en');
  assert.equal(restorableUrl('https://example.com/a?b=1&b=2&flag'), 'https://example.com/a?b=1&b=2&flag');
  assert.equal(restorableUrl('https://user:pass@example.com/'), null);
  assert.equal(restorableUrl('http://169.254.169.254/latest/'), null);
  assert.equal(restorableUrl('file:///etc/passwd'), null);
  assert.equal(restorableUrl('about:blank'), null);
  for (const name of ['code', 'State', 'csrf-token', 'oauth_verifier', 'SAMLResponse', 'X-Goog-Signature', 'client_secret', 'sessionid', 'auth_code', 'otp_code']) assert.equal(isSecretParameter(name), true, name);
  for (const name of ['q', 'page', 'lang', 'keyword', 'ticket_id', 'country_code', 'authuser', 'tab', 'view', 'utm_source']) assert.equal(isSecretParameter(name), false, name);
});
