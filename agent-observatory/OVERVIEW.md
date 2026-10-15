Agent Observatory is a dashboard for every Paseo agent and subagent on a host. Each session opens on its result, timeline, subtasks, diagnostics and an execution review. It adds a sidebar count of what needs you with a reason per agent, approvals and quick replies in place, an unread queue, usage statistics, token counts from local Claude Code, Codex, Grok CLI and Pi logs, every scheduled run, and optional AI reviews.

It adds the sidebar pages Agent Observatory, Archived sessions and Scheduled runs, workspace and agent panels, Command Center items and `/observe`. On connect the app receives only a small stub and the badge; the rest loads when first opened.

## Setup

Requires Paseo 0.11.1 or later. AI reviews need the Grok CLI (signed in on the daemon host) or an enabled Paseo provider, chosen in Analysis settings.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Agent Observatory → Language picks one; English stands in for a missing translation. A translated copy of the bundled template in `~/.paseo/plugin-data/agent-observatory/locales/` adds a language. New AI reviews answer in the chosen language.

## What it reads

- From the daemon: agent events, attention notifications, the agent list (archived included), pending permission requests of an agent you open, profiles and providers, usage windows (`providers.listUsage()`, only while a page shows them), and timelines of what you open. In the background it reads only loaded agents.
- Token logs: `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), `~/.config/claude/projects`, `$CODEX_HOME/sessions` and `archived_sessions` (default `~/.codex`), each Grok CLI session's `usage.json` (never the conversation files) and Pi's sessions (default `~/.pi/agent/sessions`), without following symlinks. Only counters, model names, working directories and session ids are kept, never prompts or output.
- For custom providers based on these: a literal `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR` in the provider's `env`, command line or launcher script (read as text, at most 64 KB, never run; no other values), and Pi's `sessionDir` setting.
- To confirm a resume, the agent's own Claude Code, Codex or Pi session log is searched for that run's ids (compared, not kept).
- Scheduled runs: `$PASEO_HOME/schedules/*.json`, `projects/workspaces.json`, and the records of agents the daemon no longer lists. It never writes them.
- The daemon config's provider list, to tell which providers take a message mid-turn and which share a usage limit.

The plugin makes no network requests of its own.

## What it writes

Everything goes to `$PASEO_HOME/plugin-data/agent-observatory` (folder 0700; files 0600, bounded, replaced atomically): telemetry, statistics, token counts, usage-limit history, read receipts, preferences, review settings, reports and suggestions, the schedule and resume ledgers, the device's time zone name, the send ledger (messages on their way, then a week of short previews), the language state and translation templates.

The schedule ledger keeps run times, status, ids, the host's error messages (300 characters), links without credentials, schedule names and cadences, never replies or prompts. Usage-limit history keys accounts by a hashed name. Telemetry keeps why a turn stopped and a merge or pull request link, never the reply. Reports can quote sessions.

## Actions

The plugin acts on the daemon only when you ask:

- marking a result, question or error read; archiving agents (bulk archiving needs a second tap and skips heartbeat targets); restoring a workspace or an archived session;
- answering one tool permission request with the provider's own options, exactly as chosen, never in bulk or automatically;
- sending a quick reply (the button's words) or a review finding to an agent: steered into the running turn where supported, otherwise after you confirm the interruption, or queued until the turn ends; a retry is delivered at most once;
- scheduling a one-off heartbeat, at a time you confirm, that resumes an agent after its usage limit resets; it counts as done only on proof tied to that run, is never resent when the host cannot tell, and only the plugin's own resume heartbeats are deleted;
- handing a stopped agent over to another profile, and starting an agent from a suggestion.

Some use daemon messages the plugin API lacks, over its own daemon connection. It can open http(s) links.

## AI reviews

Nothing is reviewed until you start a review; automatic reviews are off by default. A review sends a bounded session excerpt (prompts, replies, tool calls and output; at most 180 entries, about 120,000 characters) with project and agent metadata to the chosen model. Common credential formats are masked first, and again in stored reports, but not exhaustively. Suggestions send recent report summaries the same way.

- Grok CLI: `grok` runs in a fresh temporary directory with every built-in tool removed, tool calls denied, web search, memory and session search off, and no other providers' keys in its environment; the excerpt passes through a temporary file. Afterwards the plugin deletes the directory, the saved session and its record in Grok's session-search index. It is the only subprocess the plugin starts.
- A Paseo profile or provider: a temporary sub-agent of the reviewed agent in its workspace, in a read-only mode or Claude Code's Always Ask, where approvals are denied but actions needing none, such as reading files, still run (unmasked). It is archived afterwards; its conversation stays in the host's and the provider's logs, and its usage counts against that provider.
- Choose automatically (the default) uses the Grok CLI when found, otherwise an enabled Claude Code or Codex provider.

## Limits

- Imports and scans are capped (for example 20,000 token logs); the pages say when a cap applied.

The scheduled runs page is modeled on the schedule-runs plugin by panrafal.
