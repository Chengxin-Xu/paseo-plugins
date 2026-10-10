Project Notes keeps tasks, prompts and ideas for each Paseo project in one board on the daemon host. Tasks move through to do, doing and done, prompts copy with one tap, and ideas are free-form notes. Notes that belong to no project go to an inbox. From any note you can start work: the plugin creates a workspace and an agent in the project you pick and sends the note as the first message.

The interface is in Simplified Chinese. Open it from the sidebar item 拾页 · 项目手记, the 项目手记 workspace panel, the Command Center or the `/notes` slash command, which only opens the panel.

## Setup

Requires Paseo 0.11.1 or later on the daemon and on each app that shows it. There are no accounts, tokens or settings.

Installing from Git runs two commands in the plugin directory. `npm ci --omit=dev --ignore-scripts` downloads esbuild (with its prebuilt binary for the host platform) and zod from the npm registry at the versions in the committed lockfile. `npm run build` then bundles the command-line tool from `server/cli.ts` into `bin/notes.mjs`. The daemon host needs npm and registry access. The plugin itself only uses libraries that Paseo provides.

Starting work needs a provider that is ready on that host with at least one model. The plugin offers the providers, models and agent profiles Paseo reports, including custom ones, with no built-in defaults.

## Using it

- Tasks show as three columns on wide screens and collapsible groups on phones; tapping a status circle advances the task.
- Notes can be pinned, flagged as important, searched, filtered by project and grouped by project.
- Deleting moves a note to the trash, where it can be restored. The trash is never emptied; there is no permanent delete.
- Every app on the same daemon sees the same notes; an edit based on an outdated copy is refused and the draft kept.
- While visible, the board checks for changes every 5 seconds (15 after a quiet minute). It stops in the background or when hidden.

## Starting work from a note

The start dialog asks for the target project, a new Git worktree or the project directory, and the provider, model, permission mode and thinking level (or an agent profile). Nothing is created until you confirm. The plugin then creates the workspace (a worktree gets a new `notes/<id>` branch) and an agent labeled with the launch and note IDs, and sends the note text, as edited, to that agent and so to its provider. Repeated taps and retries reuse the launch and never create a second workspace or agent. If a plugin reload interrupts a launch, the dialog says the result needs checking and looks up the agent by its label, creating nothing.

## Command-line tool for agents

`node bin/notes.mjs --help` in the plugin directory lists commands to list, add, show, update, complete, delete and restore notes, with `--json` output. Without `--project`, a note goes to the Paseo project containing `PASEO_AGENT_CWD` or the current directory. To list projects it runs `paseo project ls --json`, falling back to `projects/projects.json` (up to 8 MiB) in the Paseo home directory. It writes only board and lock files, and an open board shows the changes at its next check.

`--body-file` reads any regular file the shell can read, up to 96,000 bytes, and `-` reads standard input up to the same size; directories, pipes and devices are refused. Human-readable output escapes control characters and prints times in UTC; `--json` output is unchanged.

## What it reads and writes

- Notes are unencrypted JSON files in `$PASEO_HOME/plugin-data/project-notes/boards/`, one per project, named by the SHA-256 of the project ID. `PASEO_HOME` defaults to `~/.paseo`. Directories get mode 0700 and files 0600. Writes go through a temporary file and an atomic rename, and a `.lock` file keeps the plugin and the command-line tool from writing at the same time. A writer takes over a lock only after its holder exits (or after a minute if the holder cannot be checked), and one that lost its lock saves nothing.
- Each launch keeps its stage and the created workspace and agent IDs in `$PASEO_HOME/plugin-data/project-notes/launches/`, without the prompt text.
- The plugin reads the Paseo project list, the providers and models available for the target project, and the agent profiles in the daemon configuration. Only profile names and their provider, model, mode and thinking choices reach the app, never environment variables or credentials.
- It makes no network requests of its own and starts no processes. Uninstalling it leaves the notes in place.

## Known limits

- Notes stay on the daemon that stores them. Apps connected to another host see that host's notes.
- Anyone who can use the daemon can read and change every note, so do not store passwords or API keys in notes.
- Each project holds up to 4,000 notes (trash included) and each board file up to 32 MiB. The overview loads at most 32 MiB of boards; any board beyond that shows as unavailable while the rest load.
- Provider and launch errors reach the app cut to 500 characters.
- Starting work needs a project with a folder on that host, so inbox notes ask for a target project. Worktrees need a Git project.
- A plugin reload clears the start dialog's progress in the app; the created workspace and agent stay in Paseo.
