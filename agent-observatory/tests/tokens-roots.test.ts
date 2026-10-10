import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { defaultRoots, inlineScript, launcherAssignment, launcherCandidates, literalPath, providerRoots, providerSource, readLauncherText } from "../server/tokens/roots";
import { TokenStore } from "../server/tokens/store";
import { DAY, iso } from "../server/tokens/types";

const HOME = "/home/user";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const response = (id: string, at: number) => ({ type: "assistant", timestamp: iso(at), sessionId: `session-${id}`, cwd: "/work/demo-project", requestId: `request-${id}`,
  message: { id, model: "claude-opus-5-5", content: "PRIVATE_OUTPUT", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } } });

test("default roots follow the daemon's environment, then the standard locations, without duplicates", () => {
  assert.deepEqual(defaultRoots({ home: HOME, env: {} }), [
    { source: "claude", path: "/home/user/.claude/projects" }, { source: "claude", path: "/home/user/.config/claude/projects" }, { source: "codex", path: "/home/user/.codex/sessions" }]);
  assert.deepEqual(defaultRoots({ home: HOME, env: { CLAUDE_CONFIG_DIR: "/srv/claude", CODEX_HOME: "/srv/codex" } }).map(root => root.path),
    ["/srv/claude/projects", "/home/user/.claude/projects", "/home/user/.config/claude/projects", "/srv/codex/sessions"]);
});

test("only literal absolute paths are accepted; ~ and $HOME expand at the start", () => {
  assert.equal(literalPath("~/.claude-work", HOME), "/home/user/.claude-work");
  assert.equal(literalPath("\"$HOME/.codex-team\"", HOME), "/home/user/.codex-team");
  assert.equal(literalPath("'${HOME}/x/../y'", HOME), "/home/user/y");
  assert.equal(literalPath("~", HOME), HOME);
  for (const value of ["relative/dir", "$XDG_CONFIG_HOME/claude", "/opt/$USER/claude", "`pwd`/x", "", "\"\""]) assert.equal(literalPath(value, HOME), null, value);
});

test("a provider writes Claude Code or Codex logs when it is one of them or extends one", () => {
  assert.equal(providerSource("claude", {}), "claude");
  assert.equal(providerSource("codex", { enabled: false } as never), "codex");
  assert.equal(providerSource("claude-team", { extends: "claude" }), "claude");
  assert.equal(providerSource("codex-proxy", { extends: "codex" }), "codex");
  assert.equal(providerSource("kimi", { extends: "acp" }), null);
  assert.equal(providerSource("opencode", {}), null);
});

test("launcher text: the last literal assignment wins, in shell, dict and environment-update forms", () => {
  const shell = ["#!/bin/sh", "# export CLAUDE_CONFIG_DIR=/commented/out", "export CLAUDE_CONFIG_DIR=/home/user/.claude", "exec claude \"$@\""].join("\n");
  assert.equal(launcherAssignment(shell, "CLAUDE_CONFIG_DIR", HOME), "/home/user/.claude");
  assert.equal(launcherAssignment("CODEX_HOME=\"$HOME/.codex-proxy\" exec codex", "CODEX_HOME", HOME), "/home/user/.codex-proxy");
  assert.equal(launcherAssignment("export CLAUDE_CONFIG_DIR=/a\nexport CLAUDE_CONFIG_DIR='/b'\n", "CLAUDE_CONFIG_DIR", HOME), "/b");
  assert.equal(launcherAssignment("env = {'CLAUDE_CONFIG_DIR': '/srv/team/claude'}", "CLAUDE_CONFIG_DIR", HOME), "/srv/team/claude");
  assert.equal(launcherAssignment("os.environ[\"CODEX_HOME\"] = \"~/.codex-b\"", "CODEX_HOME", HOME), "/home/user/.codex-b");
  assert.equal(launcherAssignment("process.env.CLAUDE_CONFIG_DIR = '/opt/claude'", "CLAUDE_CONFIG_DIR", HOME), "/opt/claude");
  // Computed values are never evaluated.
  assert.equal(launcherAssignment("env['CLAUDE_CONFIG_DIR'] = str(ROOT / '.claude')", "CLAUDE_CONFIG_DIR", HOME), null);
  assert.equal(launcherAssignment("export CLAUDE_CONFIG_DIR=$(mktemp -d)", "CLAUDE_CONFIG_DIR", HOME), null);
  assert.equal(launcherAssignment("export OTHER_DIR=/x", "CLAUDE_CONFIG_DIR", HOME), null);
});

test("the launcher is the command itself, or the script after an interpreter; -c scripts are read inline", () => {
  assert.deepEqual(launcherCandidates(["/home/user/bin/claude-team", "--verbose"], HOME), ["/home/user/bin/claude-team"]);
  assert.deepEqual(launcherCandidates(["~/bin/codex-proxy"], HOME), ["/home/user/bin/codex-proxy"]);
  assert.deepEqual(launcherCandidates(["/usr/bin/python3", "-u", "/opt/launch.py", "team"], HOME), ["/opt/launch.py"]);
  assert.deepEqual(launcherCandidates(["claude"], HOME), [], "a bare name on PATH is a binary, not a launcher");
  assert.deepEqual(launcherCandidates(["bash", "-c", "export CLAUDE_CONFIG_DIR=/x; exec claude"], HOME), []);
  assert.equal(inlineScript(["bash", "-c", "export CLAUDE_CONFIG_DIR=/x; exec claude"]), "export CLAUDE_CONFIG_DIR=/x; exec claude");
  assert.equal(inlineScript(["claude", "-c"]), null);
});

test("custom providers that move their config directory add roots; env wins over the launcher; others add none", async () => {
  const reads: string[] = [];
  const texts: Record<string, string> = {
    "/home/user/bin/claude-team": "#!/bin/sh\nexport CLAUDE_CONFIG_DIR=/home/user/.claude-team\nexec claude \"$@\"\n",
    "/home/user/bin/codex-proxy": "#!/bin/sh\nexport CODEX_HOME=/home/user/.codex\nexec codex \"$@\"\n",
    "/home/user/bin/launch.py": "import os\nenv = dict(os.environ)\nenv['CLAUDE_CONFIG_DIR'] = str(ROOT / '.claude')\n",
  };
  const roots = await providerRoots({
    claude: { enabled: false },
    "claude-team": { extends: "claude", command: ["/home/user/bin/claude-team"] },
    "claude-env": { extends: "claude", command: ["/home/user/bin/claude-team"], env: { CLAUDE_CONFIG_DIR: "~/.claude-env", ANTHROPIC_API_KEY: "never-read" } },
    "codex-proxy": { extends: "codex", command: ["/home/user/bin/codex-proxy"] },
    "codex-inline": { extends: "codex", command: ["env", "CODEX_HOME=/srv/codex", "codex"] },
    "claude-python": { extends: "claude", command: ["/usr/bin/python3", "/home/user/bin/launch.py"] },
    kimi: { extends: "acp", command: ["/home/user/bin/claude-team"], env: { CLAUDE_CONFIG_DIR: "/never" } },
    broken: null,
  }, { home: HOME, env: {}, readText: async path => { reads.push(path); return texts[path] ?? null; } });
  assert.deepEqual(roots, [
    { source: "claude", path: "/home/user/.claude-team/projects", provider: "claude-team", via: "launcher" },
    { source: "claude", path: "/home/user/.claude-env/projects", provider: "claude-env", via: "env" },
    { source: "codex", path: "/home/user/.codex/sessions", provider: "codex-proxy", via: "launcher" },
    { source: "codex", path: "/srv/codex/sessions", provider: "codex-inline", via: "command" },
  ]);
  assert.deepEqual(reads, ["/home/user/bin/claude-team", "/home/user/bin/codex-proxy", "/home/user/bin/launch.py"], "only launchers of Claude / Codex providers without an env value are read");
});

test("launcher reads are bounded: small text files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-"));
  try {
    await writeFile(join(root, "small.sh"), "export CODEX_HOME=/x\n");
    await writeFile(join(root, "big.sh"), "#".repeat(70 * 1024));
    await writeFile(join(root, "binary"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    assert.equal(await readLauncherText(join(root, "small.sh")), "export CODEX_HOME=/x\n");
    assert.equal(await readLauncherText(join(root, "big.sh")), null);
    assert.equal(await readLauncherText(join(root, "binary")), null);
    assert.equal(await readLauncherText(join(root, "missing")), null);
    assert.equal(await readLauncherText(root), null, "a directory is not a launcher");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a custom provider's log root found after the first import counts its whole history once, and is remembered", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-store-"));
  const standard = join(root, "standard"), custom = join(root, "custom-config"), directory = join(root, "data"), launcher = join(root, "claude-team");
  await mkdir(standard, { recursive: true }); await mkdir(join(custom, "projects", "-work-demo-project"), { recursive: true });
  await writeFile(join(standard, "s.jsonl"), line(response("recent", NOW - 60_000)));
  // One call from 90 days ago: past the 60-day dedupe window, so it would be taken for copied history in a known root.
  await writeFile(join(custom, "projects", "-work-demo-project", "old.jsonl"), line(response("old", NOW - 90 * DAY)) + line(response("new", NOW - 30_000)));
  await writeFile(launcher, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${custom}"\nexec claude "$@"\n`);
  let configReads = 0;
  const paseo = { config: { get: async () => { configReads++; return { requestId: "r", config: { providers: { "claude-team": { extends: "claude", command: [launcher] } } } }; } } } as unknown as PaseoApi;
  let now = NOW;
  const options = { directory, roots: [{ source: "claude" as const, path: standard }], now: () => now, poll: false, rootContext: { home: root, env: {} } };
  let store = new TokenStore(options);
  try {
    await store.ready;
    await store.poll(true); // the first rescan sets the dedupe floor
    assert.ok(store.ingester.seenFloor !== null);
    await store.discover(paseo); await store.poll(true);
    assert.deepEqual(store.ingester.roots.map(item => item.path), [standard, join(custom, "projects")]);
    const first = await store.read({ range: "90d", utcOffsetMinutes: 0 });
    if (first.mode !== "full") throw new Error("full expected");
    assert.equal(first.allTime.calls, 3, "the 90-day-old call of the late root is counted");
    await store.discover(paseo);
    assert.equal(configReads, 1, "the provider config is read at most every 5 minutes");
    await store.close();
    // Restart: the remembered root keeps its read positions, so nothing is imported again.
    store = new TokenStore(options); await store.ready; await store.poll(true);
    assert.deepEqual(store.ingester.roots.map(item => item.path), [standard, join(custom, "projects")]);
    assert.equal(store.ingester.diagnostics.calls, 0);
    now += 6 * 60_000; await store.discover(paseo); await store.poll(true);
    assert.equal(configReads, 2); assert.equal(store.ingester.roots.length, 2, "an already watched root is not added twice");
    const restored = await store.read({ range: "90d", utcOffsetMinutes: 0 });
    if (restored.mode !== "full") throw new Error("full expected");
    assert.equal(restored.allTime.calls, 3);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("discovery failures leave the default roots working", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-fail-"));
  let now = NOW;
  const store = new TokenStore({ directory: join(root, "data"), roots: [{ source: "claude", path: join(root, "logs") }], now: () => now, poll: false, rootContext: { home: root, env: {} } });
  try {
    await store.ready;
    await store.discover({ config: { get: async () => { throw new Error("denied"); } } } as unknown as PaseoApi);
    now += 6 * 60_000;
    await store.discover({} as PaseoApi);
    assert.equal(store.ingester.roots.length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
