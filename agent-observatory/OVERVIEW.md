Agent Observatory is a dashboard for every Paseo agent and subagent on a host. A session opens on its result: the first prompt pinned at the top, the latest reply, then the timeline, subtasks, diagnostics and an execution review that charts where the time went. Around that it adds an unread queue for finished work, usage statistics and model comparisons, token counts from local Claude Code and Codex logs, a page listing every scheduled run, and optional AI reviews of sessions.

The interface is in Simplified Chinese, for desktop and phone layouts in light and dark themes. It adds the sidebar pages Agent 观测台, 已归档会话 (archived sessions) and 定时运行 (scheduled runs), a workspace panel, an agent panel, Command Center items and the `/observe` slash command.

## Setup

Requires Paseo 0.11.1 or later. Sessions, statistics and scheduled runs need no setup. Token statistics need Claude Code or Codex logs on the daemon host. AI reviews need the Grok CLI (installed and signed in on the daemon host) or an enabled Paseo provider; the default picks one by itself, and others can be chosen in 分析设置 (analysis settings).

## What it reads

- From the daemon: agent lifecycle events (turns, approvals, archiving) and subagent updates, the agent list (archived agents included), agent profiles and the provider list, subtask lists, and projected timelines when you open an agent, a review or a result. In the background it reads only loaded agents, since reading an unloaded one loads it.
- Token logs: `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), `~/.config/claude/projects` and `$CODEX_HOME/sessions` (default `~/.codex/sessions`), without following symlinks. Every session on the host is counted, not only those Paseo started. Only counters, model names, working directories and session ids are kept, never prompts or output.
- Custom providers that extend Claude Code or Codex may keep logs elsewhere: the plugin looks for a literal `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the provider's `env`, command line or launcher script (read as text, at most 64 KB, never run). No other environment value is used.
- Scheduled runs: `$PASEO_HOME/schedules/*.json`, `projects/workspaces.json`, and the `agents/*/*.json` records of agents the daemon no longer lists. These files are never written.

`PASEO_HOME` must be absolute or start with `~/`; otherwise `~/.paseo` is used. The plugin makes no network requests of its own.

## What it writes

Everything goes to `$PASEO_HOME/plugin-data/agent-observatory`: `telemetry.json`, `stats.json`, `tokens.json`, `read-receipts.json`, `preferences.json`, `insight-settings.json`, `insight-index.json`, `insight-suggestions.json`, the `insight-reports/` folder and `schedule-ledger.json`, plus backup copies of files it could not read. The folder is 0700 (a wider existing one is tightened); files are 0600, bounded in size and replaced atomically.

The schedule ledger keeps run times, status, agent and workspace ids, error excerpts (300 characters) and links, plus schedule names (未命名定时任务 and a short id when unnamed) and cadences, never replies or prompts, so runs stay listed after Paseo deletes a schedule. Review reports can contain code or text quoted from sessions.

## Actions

The plugin acts on the daemon only when you ask it to: marking a result read (this clears the agent's attention flag), archiving an agent, restoring a workspace and reopening an archived session, sending a review finding back to an agent as a message, and starting a new agent from a suggestion. Some use daemon messages the plugin API lacks, sent over the plugin's own daemon connection. It can also copy text and open http(s) links in the browser.

## AI reviews

Nothing is reviewed until you start a review; automatic reviews are off by default. A review sends a bounded excerpt of the session (prompts, replies, tool calls and their output; at most 180 entries and about 120,000 characters) with project and agent metadata to the reviewer. Common credential formats (private keys, JWTs, API keys, tokens, passwords) are masked first, but the masking is not exhaustive. Suggestions (建议) send recent report summaries the same way.

- Grok CLI: runs `grok` as a subprocess in an empty temporary directory, with tools, subagents and web search turned off; model and reasoning effort are settings (default grok-4.7, xhigh). The excerpt goes through a temporary file that is deleted afterwards. This is the only subprocess the plugin starts.
- A Paseo profile or provider: a temporary sub-agent of the reviewed agent, in its workspace, in a read-only mode (Codex's read-only sandbox, Cursor's Ask, plan modes) or else Claude Code's Always Ask, where approval requests are denied but actions needing no approval, such as reading files, still run. Providers without either mode cannot run reviews. Profiles contribute only speed and reasoning switches, auto-accept stays off, and tools the host injects into every agent follow host settings. It is archived afterwards and its usage counts against that provider.
- 自动选择 (automatic, the default for new installs) uses the Grok CLI when found, otherwise an enabled Claude Code or Codex provider (or one that extends them) with its default model; other providers only when you pick them.

## Limits

- Token statistics read the Claude Code and Codex log formats only and do not estimate costs.
- Log imports and scans are capped (for example 20,000 token logs or 2,000 schedule files); the pages say when a cap applied.
- Turn, duration and tool statistics start when the plugin is installed.
- Layouts are tested in browsers at desktop and phone sizes, not on physical iOS or Android devices.

The scheduled runs page is modeled on the schedule-runs plugin by panrafal.
