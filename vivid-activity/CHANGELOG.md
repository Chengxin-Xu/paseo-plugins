# Changelog

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
