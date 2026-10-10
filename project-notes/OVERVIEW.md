Project Notes keeps tasks, prompts and ideas for each Paseo project in one board on the daemon host. Tasks move through to do, doing and done, prompts copy with one tap, and ideas are free-form notes. Notes that belong to no project go to an inbox. From any note you can start work: the plugin creates a workspace and an agent in the project you pick and sends the note as the first message.

The interface is in Simplified Chinese. Open it from the sidebar item 拾页 · 项目手记, the 项目手记 panel in a workspace, the Command Center, or the `/notes` slash command, which only opens the panel and sends nothing to the agent.

## Setup

Requires Paseo 0.11.1 or later on the daemon and on each app that shows it. There are no accounts, tokens or settings.

Installing from Git runs two preparation commands in the plugin directory. `npm ci --omit=dev --ignore-scripts` downloads esbuild (with its prebuilt binary for the host platform) and zod from the npm registry, at the versions pinned in the committed lockfile. `npm run build` then bundles the command-line tool from `server/cli.ts` into `bin/notes.mjs`. The daemon host needs npm and access to the npm registry. The plugin itself only uses libraries that Paseo provides.

Starting work from a note needs a provider that is ready on that host and lists at least one model. The plugin offers whatever providers, models and agent profiles Paseo reports, including custom providers, and has no built-in defaults.

## Using it

- Tasks show as three columns on wide screens and as collapsible groups on phones. Tapping a task's status circle moves it to the next status.
- Notes can be pinned, flagged as important, searched, filtered by project and grouped by project.
- Deleting moves a note to the trash, where it can be restored. The trash is never emptied, and there is no permanent delete.
- Every app connected to the same daemon sees the same notes. An edit based on an outdated copy is refused and the draft is kept.
- While the board is visible it checks for changes about every 5 seconds, or every 15 seconds after a quiet minute. It stops while the app is in the background or the view is hidden.

## Starting work from a note

The start dialog asks for the target project, a new Git worktree or the project directory, and the provider, model, permission mode and thinking level, or an agent profile. Nothing is created until you confirm. Then the plugin creates the workspace (a worktree gets a new `notes/<id>` branch), creates an agent labeled with the launch and note IDs, and sends the note text, as edited in the dialog, to that agent and so to the provider you chose. Repeated taps and retries reuse the same launch and never create a second workspace or agent. If a plugin reload interrupts a launch, the dialog says the result needs checking and looks up the agent by its label without creating anything.

## Command-line tool for agents

`node bin/notes.mjs --help` in the plugin directory lists commands to list, add, show, update, complete, delete and restore notes, with `--json` output. Without `--project`, a new note goes to the Paseo project that contains `PASEO_AGENT_CWD` or the current directory. To list projects it runs `paseo project ls --json`, and if that fails it reads `projects/projects.json` in the Paseo home directory. `--body-file` reads the file you name. The tool writes only the board files and their lock files, and an open board shows its changes at the next check.

## What it reads and writes

- Notes are unencrypted JSON files in `$PASEO_HOME/plugin-data/project-notes/boards/`, one per project, named by the SHA-256 of the project ID. `PASEO_HOME` defaults to `~/.paseo`. Directories get mode 0700 and files 0600. Writes go through a temporary file and an atomic rename, and a `.lock` file keeps the plugin and the command-line tool from writing at the same time.
- Each launch keeps its stage and the created workspace and agent IDs in `$PASEO_HOME/plugin-data/project-notes/launches/`, without the prompt text.
- The plugin reads the Paseo project list, the providers and models available for the target project, and the agent profiles in the daemon configuration. Only profile names and their provider, model, mode and thinking choices reach the app, never environment variables or credentials.
- It makes no network requests of its own and starts no processes. Uninstalling it leaves the notes in place.

## Known limits

- Notes stay on the daemon that stores them. Apps connected to another host see that host's notes.
- Anyone who can use the daemon can read and change every note, so do not store passwords or API keys in notes.
- Each project holds up to 4,000 notes, including the trash, and each board file up to 32 MiB.
- Starting work needs a project with a folder on that host, so inbox notes ask for a target project. Worktrees need a Git project.
- The start dialog keeps its progress in the app. A plugin reload clears it, while the created workspace and agent stay in Paseo.
