import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedHostResolverRules, isBlockedHost, isSecretParameter, normalizeNavigationUrl, restorableUrl, withoutCredentials } from '../server/navigation';

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

test('viewer and Agent addresses lose only the account and password; query and fragment stay', () => {
  assert.equal(withoutCredentials('https://user:pw@example.com/a?code=1#x'), 'https://example.com/a?code=1#x');
  assert.equal(withoutCredentials('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(withoutCredentials('about:blank'), 'about:blank');
  assert.equal(withoutCredentials('not a url'), 'not a url');
});

test('saved tab addresses drop verification codes, PINs, hashes, assertions and session path parameters (a name heuristic)', () => {
  const origin = 'https://app.example.com';
  const dropped = ['passWord', 'PassWord', 'passWd', 'userPassWord', 'pWd', 'verification_code', 'verify_code', 'sms_code', 'mfa_code', 'confirmation_code', 'invite_code', 'reset_code', 'oobCode', 'verificationCode', 'code_challenge', 'totp', 'totp_code', 'passcode', 'pin', 'pin_code', 'pass', 'hash', 'hmac', 'x_hmac_sha256', 'assertion', 'client_assertion', 'PHPSESSID', 'ott'];
  for (const name of dropped) assert.equal(restorableUrl(`${origin}/verify?${name}=123456&lang=en`), `${origin}/verify?lang=en`, name);
  const kept = ['country_code', 'zipCode', 'postal_code', 'currency_code', 'language_code', 'shipping', 'hashtag', 'passenger', 'spinner', 'bottom', 'zipcode'];
  for (const name of kept) assert.equal(restorableUrl(`${origin}/search?${name}=1`), `${origin}/search?${name}=1`, name);
  assert.equal(restorableUrl(`${origin}/app;jsessionid=ABC123/item;color=red?q=1`), `${origin}/app/item;color=red?q=1`);
  assert.equal(restorableUrl(`${origin}/cart;JSESSIONID=ABC123`), `${origin}/cart`);
  assert.equal(restorableUrl(`${origin}/auth/action?mode=resetPassword&oobCode=abc&apiKey=k&continueUrl=%2Fhome`), `${origin}/auth/action?mode=resetPassword&continueUrl=%2Fhome`);
});
