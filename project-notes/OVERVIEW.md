Project Notes keeps tasks, prompts and ideas for each Paseo project on the daemon host. Tasks move through to do, doing and done; prompts support reusable variables; unassigned notes go to an inbox. Start work from a note by choosing a project and an agent, then editing its initial task.

Open Project Notes from the sidebar, the workspace panel, or the Command Center. `/notes` opens the panel, `/notes <text>` saves an inbox idea, and `/prompt` opens the prompt library.

## Setup

Requires Paseo 0.11.1 or later on both daemon and app. No accounts or tokens are needed. Git preparation downloads the locked esbuild and zod dependencies from npm and builds the CLI, so the host needs npm and registry access. Starting work requires a configured provider; available models and profiles come from Paseo.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Project Notes → Language picks one; the CLI follows the same choice and English stands in for a missing translation. A translated copy of the bundled template in `~/.paseo/plugin-data/project-notes/locales/` adds a language. Notes keep the language they were written in.

## Using notes and prompts

- Pin, flag, search and filter notes by project. Wide screens show task columns; phones use collapsible groups. Concurrent edits reject outdated changes and keep the draft.
- Deletion moves notes to the trash. Permanent deletion requires confirmation and removes history too. Emptying trash affects every trashed note in the selected project scope, including notes hidden by search.
- Visible boards synchronize every 5 seconds, or 15 after a quiet minute; background polling stops. Local edits keep incremental synchronization.
- Prompt templates replace literal `{{variables}}`. On web and Mac desktop, the composer pill fills, appends or replaces a draft and can undo its insertion before further editing. Copy remains available on native apps or when insertion is unavailable.
- A four-section template helps specify goals, scope, constraints and acceptance. Suggestions read bounded project manifests without executing commands.
- Sending checks the agent, including unloaded sessions, and confirms interruptions or pending approvals. Instead of interrupting, you can choose "Send when this turn ends": the plugin server queues the prompt and sends it once the turn ends and no approval is pending, even with the app closed. Every prompt sent from the picker is written to the plugin's send ledger first; afterwards a 160-character preview stays for a week. A queued prompt pauses for your OK if someone else wrote to the agent meanwhile. The same prompt is never sent directly while a copy waits in the queue, from any picker or device. Retries keep the message ID and send options. An unknown result requires checking the conversation. Remove composer attachments before using plugin slash commands on Paseo 0.11.1.

## Starting work

Choose a project directory or new Git worktree, workspace title, provider, model and agent settings. Nothing is created before confirmation. The edited initial task is sent to the chosen provider. Its source attachment contains only the note ID, title, project, status and importance; it does not repeat the saved body. The separate composer attachment picker still attaches note content when explicitly selected.

The workspace retains your title, and a worktree uses `notes/<id>`. This launch path does not request automatic naming or an extra naming-model call. Repeated requests reuse creation keys. After interruption, recovery searches agent labels and the project's worktree slugs without recreating resources. Finding a workspace disables changing options and starting again. Only a confirmed rejection before creation allows new options. Unresolved results require checking Paseo; local workspaces cannot be reliably matched without a saved ID.

## Data and command line

Notes are unencrypted JSON under `$PASEO_HOME/plugin-data/project-notes/boards/`, with separate snapshots in `boards/history/` and launch stages in `launches/`. The default home is `~/.paseo`. Launch records contain resource IDs, a hash of the launch input and provider or daemon errors (500 characters), not task text. Atomic writes and shared locks protect plugin and CLI updates. Language state and translation templates sit beside them. Uninstalling leaves data in place.

Title, body and type edits retain ten recent snapshots; status changes do not. Existing inline history migrates without dropping versions, and migrated snapshots remain protected. Reading accepts document versions 1 and 2; writing uses version 2. **After upgrading, you cannot directly roll back to 0.9.0.** Committed snapshot keys also persist beside the history, allowing recovery when the board loses its keys.

Back up and restore the whole data directory together. Missing snapshots are reported. In note details, "Discard missing snapshots and continue" asks for confirmation before removing their references while preserving current content and available history, allowing content edits again.

`node bin/notes.mjs --help` lists CLI commands. Output normally contains current content; `show --history` reads snapshots. Even `list` and `show` may migrate old data and write boards, history and locks. Body-file input accepts regular files up to 96,000 bytes, or bounded stdin. Other accounts on the host can see command lines, so pass private text with `--body-file -`, never `--body` or the title. Human-readable output escapes control characters and uses UTC.

## Limits and privacy

Each project allows 4,000 notes including trash and a 32 MiB board; an overview loads at most 32 MiB of boards. Oversized boards appear unavailable. Notes stay on their daemon and are accessible to everyone using it; avoid passwords and keys. The plugin makes no network requests itself. Starting work sends the confirmed task and source metadata through Paseo to the selected provider. Provider and launch errors are capped at 500 characters.
