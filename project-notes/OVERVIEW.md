Project Notes keeps tasks, prompts and ideas for each Paseo project on the daemon host. Tasks move through to do, doing and done; prompts support reusable variables; unassigned notes go to an inbox. Start work from a note by choosing a project and an agent, then editing its initial task. One-tap prompt pills and live agent status on task cards are included.

Open Project Notes from the sidebar, the workspace panel, or the Command Center. `/notes` opens the panel, `/notes <text>` saves an inbox idea, and `/prompt` opens the prompt library.

## Setup

Requires Paseo 0.11.1 or later on both daemon and app. No accounts or tokens are needed. Git preparation downloads the locked esbuild and zod dependencies from npm and builds the CLI, so the host needs npm and registry access. Starting work requires a configured provider; available models and profiles come from Paseo.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Project Notes → Language picks one; the CLI follows the same choice and English stands in for a missing translation. A translated copy of the bundled template in `~/.paseo/plugin-data/project-notes/locales/` adds a language. Notes keep the language they were written in.

## Using notes and prompts

- Pin, flag, search and filter notes by project. Concurrent edits reject outdated changes and keep the draft.
- Deletion moves notes to the trash. Permanent deletion requires confirmation and removes history too. Emptying trash affects every trashed note in the selected project scope, including notes hidden by search.
- Visible boards synchronize every 5 seconds, or 15 after a quiet minute; hidden boards do not poll.
- Prompt templates replace literal `{{variables}}`. On web and Mac desktop, the composer pill fills, appends or replaces a draft and can undo its insertion before further editing. Copy remains available on native apps or when insertion is unavailable.
- A four-section template helps specify goals, scope, constraints and acceptance. Suggestions read bounded project manifests without executing commands.
- Sending checks the agent, including unloaded sessions, and confirms interruptions or pending approvals. "Send when this turn ends" queues the prompt on the plugin server, which sends it once the turn ends and no approval is pending, even with the app closed. Prompts are written to the plugin's send ledger first; afterwards a 160-character preview stays for a week. A queued prompt pauses for your OK if someone else wrote to the agent meanwhile, and the same prompt is never on its way twice, from any device. Remove composer attachments before using plugin slash commands on Paseo 0.11.1.

## One-tap prompts

Turn on "One-tap send" in a prompt's details to show it as a short pill above every agent's composer; more than three fold into one menu pill. A tap sends at once when the agent is idle, unloaded, or takes messages mid-turn. When it is running without that, or waits for an approval, the pill asks first: send once the turn or approval is done, or send now anyway. A tap never interrupts on its own. Prompts with variables open their fill form. Sends use the same ledger as the picker. The ordered list is a host setting shared by every device; pills follow its change events without polling.

## Task status

Task cards show the agents started from them: running (blue), needs you (amber), done but unread (green), error (red) or idle, with sub-agents and last activity. A tap opens the agent, and the details list every launch. Archived or deleted agents show as ended. Status comes only from Paseo's agent directory and the plugin's launch records; no conversation is read, so unloaded agents stay unloaded.

## Starting work

Choose a project directory or new Git worktree, workspace title, provider, model and agent settings. Nothing is created before confirmation. The edited initial task is sent to the chosen provider. Its source attachment contains only the note ID, title, project, status and importance; it does not repeat the saved body. The separate composer attachment picker still attaches note content when explicitly selected.

The workspace keeps your title, and a worktree uses `notes/<id>`; no automatic naming call is made. Repeated requests reuse creation keys. After an interruption, recovery finds existing resources by agent labels and worktree slugs instead of creating new ones; only a confirmed rejection before creation allows starting again with new options. Unresolved results require checking Paseo.

## Data and command line

Notes are unencrypted JSON under `$PASEO_HOME/plugin-data/project-notes/boards/`, with separate snapshots in `boards/history/` and launch stages in `launches/`. The default home is `~/.paseo`. Launch records contain resource IDs, the note ID, a hash of the launch input and provider or daemon errors (500 characters), not task text. The one-tap list sits in `plugin-settings/project-notes/quick-prompts.json` with note IDs, projects and title copies. Atomic writes and shared locks protect plugin and CLI updates. Language state and translation templates sit beside them. Uninstalling leaves data in place.

Title, body and type edits retain ten recent snapshots; status changes do not. Older inline history migrates without loss. Boards are written as version 2, so **after upgrading you cannot directly roll back to 0.9.0.** Back up and restore the whole data directory together; missing snapshots are reported, and note details can discard their references after confirmation.

`node bin/notes.mjs --help` lists CLI commands. Even `list` and `show` may migrate old data and write boards, history and locks. Body-file input accepts regular files up to 96,000 bytes, or bounded stdin. Other accounts on the host can see command lines, so pass private text with `--body-file -`, never `--body` or the title.

## Limits and privacy

Each project allows 4,000 notes including trash and a 32 MiB board; an overview loads at most 32 MiB of boards. Oversized boards appear unavailable. Notes stay on their daemon and are accessible to everyone using it; avoid passwords and keys. The plugin makes no network requests itself. Starting work sends the confirmed task and source metadata through Paseo to the selected provider.
