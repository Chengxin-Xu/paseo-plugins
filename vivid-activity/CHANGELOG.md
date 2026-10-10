# Changelog

## 0.4.1 (2026-10-10)

Security hardening after an outside review of 0.4.0. Image previews, folding and timing work as before.

**Image previews**

- A preview request must name the agent whose chat shows the image, and the daemon must know that agent; otherwise
  nothing is read, not even the temp directory. A sub-agent's own view (`provider:<agent>:<subagent>`) uses its parent
  agent's working directory.
- The temp directory is `os.tmpdir()` alone. `/tmp` is added only on macOS, where agents and browser tools save
  screenshots and `os.tmpdir()` is a per-user folder. A `TMPDIR` that is `/` or contains the home directory is ignored.
- Files are read in 64 KB pieces and never past 3 MB plus one byte, even when a file grows after its size was checked.
  A file that does not start like a supported image is not read past its first 32 bytes, and its size is no longer
  reported.
- After opening, the plugin checks the file it actually opened. On Linux it reads the real path from `/proc/self/fd`,
  so a directory swapped for a link between the checks and the open is refused; elsewhere the checked path must still
  name the same device and inode, which narrows that window.
- A BMP needs a file size field that matches the file, a known DIB header size and a pixel data offset inside the file,
  not just `BM`.

**Parsing limits**

- Looking for JSON after a prefix in MCP and command output tries at most 8 `{`/`[` positions and only text up to
  100,000 characters. Crafted output with nested brackets could keep the app or the daemon busy for minutes.
- The fold index counts a tool call holding more than a million characters as "other" without parsing it, and keys
  reasoning longer than 64 K characters by its length and its first and last 32 K characters.

**Memory**

- The fold index, timings and pending-approval state of an agent none of whose rows has been on screen for 10 minutes
  are dropped, and read again when you come back.

**Tests**

- The Hermes bundle test writes into a private `mkdtemp` directory. The host fixture's agent and message ids are
  synthetic and its timestamps shifted to 2026-01-01.

## 0.4.0 (2026-10-10)

First public release, based on Colorful Agent Activity 0.3.0
([mcowger/paseo-plugins@e65409b](https://github.com/mcowger/paseo-plugins/tree/e65409bbccf6d07c1bbe24dc8eddd902ee10a769/colorful-agent-activity))
by Matt Cowger. Changes from that version:

**Packaging**

- New plugin id `vivid-activity`, so it is offered rows after plugins such as Bots (`paseo-bots`) that turn some tool
  calls into their own cards.
- `@getpaseo/protocol` and `prismjs` are runtime dependencies installed by the manifest's `npm ci --omit=dev`
  preparation step. Without them the original does not compile on Paseo 0.11.1 Git installs. The agent types that
  came from `@getpaseo/client` are now taken from the host SDK, so that package stays a development dependency.
- Requires Paseo 0.11.1.

**Look and states**

- Simplified Chinese interface, including names for 61 Paseo tools.
- New default "vivid" palette: one color and icon per kind of step; running blue with a spinner, waiting for approval
  amber, failed red with the exit code, finished green. The original palette remains as "follow theme".
- The row that waits for your approval is matched to its permission request.
- Motion listeners only on rows that move; a slightly stronger state tint in the light theme.

**Folding, density and timing**

- Finished runs of thinking and tool steps fold into one summary row; running runs keep only active, waiting, failed
  and the two latest steps open.
- Compact row density (4 px between rows) by default.
- Per-step durations estimated from the projected timeline and bounded by the agent's turn; live counters for
  running rows.

**Detail cards**

- Layered cards; command boxes with a program badge, exit code and copy buttons; file boxes with a language badge,
  line numbers and copy; a step rail for multi-step thinking.

**Behavior**

- A "takeover" setting: all rows, thinking rows only, or off.
- Plan cards and task lists are left to Paseo; the Activity Summary panel was removed.
- Claude Code failures show the error text instead of the raw tool result; MCP results wrapped as `{ output }` reach
  the GitHub, Exa and Paseo views; the task notice Claude Code adds after a command with a timeout merges into that
  command's row, and background command notices get a row of their own.
- Image previews only read files inside the agent's working directory or the system temp directory.
