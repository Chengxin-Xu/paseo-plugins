import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../server/insight-analysis";

/** Every case below is synthetic: shapes of real credential formats, never real values. */
const leaks = (text: string, secret: string) => redactSecrets(text).includes(secret);
// Fake credentials are assembled at run time so the source never carries a token-shaped literal that a host's secret scanner would flag.
const fake = (prefix: string, body: string) => `${prefix}${body}`;
const PEM_BODY = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaCVY8m0aSyLwqYq";
/** PEM armour lines, assembled so the source holds no literal key header. */
const armour = (edge: "BEGIN" | "END", kind: string) => `${"-".repeat(5)}${edge} ${kind}${"-".repeat(5)}`;

test("PEM private key blocks are removed whole, including JSON-escaped and cut-off ones", () => {
  for (const kind of ["RSA PRIVATE KEY", "PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const block = `${armour("BEGIN", kind)}\n${PEM_BODY}\n${PEM_BODY.split("").reverse().join("")}\n${armour("END", kind)}`;
    const redacted = redactSecrets(`key file:\n${block}\ndone`);
    assert.equal(redacted.includes(PEM_BODY), false, kind); assert.match(redacted, /\[private key redacted\]/); assert.match(redacted, /^key file:\n[\s\S]*\ndone$/);
  }
  assert.equal(leaks(JSON.stringify({ private_key: `${armour("BEGIN", "PRIVATE KEY")}\n${PEM_BODY}\n${armour("END", "PRIVATE KEY")}\n`, client_email: "bot@example.com" }), PEM_BODY), false);
  // An excerpt can end inside the key: everything after the header goes.
  assert.equal(leaks(`${armour("BEGIN", "OPENSSH PRIVATE KEY")}\n${PEM_BODY}`, PEM_BODY), false);
  // Certificates and public keys are not secrets.
  const certificate = `${armour("BEGIN", "CERTIFICATE")}\n${PEM_BODY}\n${armour("END", "CERTIFICATE")}`;
  assert.equal(redactSecrets(certificate), certificate);
  assert.equal(redactSecrets(`${armour("BEGIN", "PUBLIC KEY")}\n${PEM_BODY}\n${armour("END", "PUBLIC KEY")}`).includes(PEM_BODY), true);
});

test("JWTs are masked wherever they appear", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkRlbW8ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  for (const text of [jwt, `cookie: session=${jwt}; Path=/`, `https://app.example.com/callback?id_token=${jwt}&state=1`, `"Authorization": "Bearer ${jwt}"`]) assert.equal(leaks(text, jwt.split(".")[2]), false, text);
  assert.equal(leaks("unsigned eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"), false);
  // A value masked by one pattern is not masked again by the key patterns.
  assert.equal(redactSecrets(`"Authorization": "Bearer ${jwt}"`), '"Authorization": "Bearer [credential redacted]"');
  assert.equal(redactSecrets(`OPENAI_API_KEY=sk-${"a1".repeat(12)}`), "OPENAI_API_KEY=[credential redacted]");
});

test("a bare Bearer token, Google, Slack and GitLab keys are masked", () => {
  const cases: Array<[string, string]> = [
    ["curl -H 'X-Api: Bearer d4f1c9b2a7e64f0b9c3e8a1d5b7f2c6e' https://api.example.com", "d4f1c9b2a7e64f0b9c3e8a1d5b7f2c6e"],
    ["bearer   abcdefghijklmnopqrstuv.wxyz-0123", "abcdefghijklmnopqrstuv"],
    [`GOOGLE_MAPS=${fake("AIza", "SyD3m0-k3yF0rT3stingOnlyXXXXXXXXXXXX")}`, fake("AIza", "SyD3m0-k3yF0rT3stingOnlyXXXXXXXXXXXX")],
    [`key ${fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")}`, fake("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q")],
    ...["xoxb", "xoxp", "xoxa", "xoxr", "xoxs"].map((prefix): [string, string] => [`slack ${prefix}-1234567890-0987654321-AbCdEfGhIjKlMnOp`, `${prefix}-1234567890-0987654321-AbCdEfGhIjKlMnOp`]),
    [`git clone https://oauth2:${fake("glpat-", "AbCdEfGhIjKlMnOpQrSt")}@git.example.test/acme/app.git`, fake("glpat-", "AbCdEfGhIjKlMnOpQrSt")],
    [`export CI_TOKEN ${fake("glpat-", "xY9_zW8-vU7tS6rQ5pO4")}`, fake("glpat-", "xY9_zW8-vU7tS6rQ5pO4")],
    [`gh auth: ${fake("ghs_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")}`, fake("ghs_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")],
  ];
  for (const [text, secret] of cases) assert.equal(leaks(text, secret), false, text);
});

test("token, secret and password assignments are masked in env, YAML, JSON, URL and header forms", () => {
  const cases: Array<[string, string]> = [
    ["token=abc123def456", "abc123def456"],
    ["TOKEN: s3cr3tvalue1", "s3cr3tvalue1"],
    ["export GITHUB_TOKEN=gho16charsonly", "gho16charsonly"],
    ['{"token": "AbCdEf9hIjKlMnOpQrSt"}', "AbCdEf9hIjKlMnOpQrSt"],
    ["session_token=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh", "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"],
    ["callback?token=7e2f9a1c44b8d6e0&next=%2Fhome", "7e2f9a1c44b8d6e0"],
    ["x-auth-token: 9f8e7d6c5b4a", "9f8e7d6c5b4a"],
    ["https://api.example.com/v1?access_token=Zx81Yw72Vu63&page=2", "Zx81Yw72Vu63"],
    ["DB_PASSWORD=correct-horse-battery", "correct-horse-battery"],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["SECRET_KEY='django-insecure-0123456789'", "django-insecure-0123456789"],
    ["client_secret: 7c4a8d09ca3762af61e59520943dc26494f8941b", "7c4a8d09ca3762af61e59520943dc26494f8941b"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw=="],
    ["apiKey: 'k-0123456789abcdef'", "k-0123456789abcdef"],
  ];
  for (const [text, secret] of cases) assert.equal(leaks(text, secret), false, text);
});

test("ordinary text, counters and documentation about credentials stay unchanged", () => {
  const ordinary = [
    "input_tokens: 123456, output_tokens: 7890, max_tokens=4096, total_tokens: 131442",
    "Tokenizer: bert-base-uncased; tokens: 512",
    "The secretary: Alice Johnson. Secrets: none were found.",
    "passwords are hashed with bcrypt; password_hash is a column name",
    "Send a Bearer token in the Authorization header; the token: everything else is public",
    "JWTs start with eyJ because they encode JSON. AIza keys, xoxb- bot tokens and glpat- tokens are prefixes worth scanning for.",
    `${armour("BEGIN", "CERTIFICATE")} is not a secret`,
    "sk-learn and pk-sharding are package names; ghp_ is the GitHub prefix",
    "令牌：请在设置里填写；密码长度至少 8 位。",
    "commit 3f2c1e9 fixed the token refresh: retries now back off",
    "const token = knownCompletionAt(agent); const token = JSON.stringify([a, b]); token = Date.parse(at); token = someVariableName;",
  ];
  for (const text of ordinary) assert.equal(redactSecrets(text), text);
});

test("redaction is linear on hostile input", () => {
  const n = 60_000;
  for (const [label, text] of [["eyJ runs", "eyJ-".repeat(n / 4)], ["dotted eyJ", "eyJaaaaaaaaaaaaa.".repeat(n / 17)], ["PEM headers", armour("BEGIN", "PRIVATE KEY").repeat(n / 27)],
    ["token keys", "token: ".repeat(n / 7)], ["bearer words", "Bearer ".repeat(n / 7)], ["assignment spaces", `password${" ".repeat(n)}x`], ["prefix runs", "sk-".repeat(n / 3)]] as const) {
    const started = performance.now(); redactSecrets(text); const took = performance.now() - started;
    assert.ok(took < 250, `${label} took ${took.toFixed(0)} ms`);
  }
});
