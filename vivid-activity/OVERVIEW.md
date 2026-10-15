Vivid Activity redraws an agent's thinking and tool-call rows in the chat as compact, color-coded activity rows. Every kind of step has its own color and icon: thinking violet, reads blue, edits green, commands orange, searches indigo, web cyan, sub-agents magenta, MCP pink, Paseo's tools sky blue. Every row also shows its state: a blue spinner while it runs, an amber pulse while it waits for your approval or your answer, red when it fails (with the exit code for commands), and a short green flash when it finishes.

A finished run of thinking and tool steps folds into one summary row with the number of steps, a count per kind, failures and the total time; tap it to see them. While the agent is still working, only the running, waiting and failed steps and the two most recent ones stay visible. Each row shows how long its step took, and running rows count up live. In a long turn, your question stays pinned above the newest stretch of activity: three lines, tap to read it all, with a copy button.

The interface supports English, Simplified Chinese and user-defined languages. Based on Colorful Agent Activity by Matt Cowger.

## What the rows show

Expanding a row shows highlighted commands with output and exit code, file reads with line numbers, colored diffs, previews of images the agent read, and dedicated views for Paseo's tools and GitHub and Exa results. Command output and terminal captures hide terminal escape codes but keep their colors. Background-task notices from Claude Code and notices from Pi extensions become short localized rows colored by outcome. Times in schedule details use your device's time zone. Plan cards, task lists, permission prompts and other plugins' cards (such as Bots proposals) are left alone and end a fold.

## Settings

No setup is needed. Requires Paseo 0.11.1 or later. Open the Vivid Activity settings page:

- Language: the device language by default, or English, Simplified Chinese or a language you add as a translated copy of the bundled template in `~/.paseo/plugin-data/vivid-activity/locales/`. English stands in for a missing translation.
- Takeover: all rows (default), thinking rows only, or off. A change redraws the open chat right away.
- Fold finished thinking and tool steps: on by default.
- Row density: compact (default, 4 px gaps) or standard (10 px).
- Pin this turn's question: on by default.
- Palette: vivid (default), follow the theme accent, soft, or high contrast.
- Expansion for each kind of row: always, newest only, or collapsed. Reads, edits, writes, commands and questions start collapsed.

Settings live on the daemon and apply to every connected device. Agent output, prompts and paths keep their original text.

## Data and permissions

- To fold and time rows, the plugin's server part reads the timeline of the agent you are viewing inside the daemon and sends the app a compact index: each row's position, end time, kind, status and category, tool call and turn ids, text lengths and a short hash of thinking text. No text or tool output is part of it. For the pinned question it sends that message's text.
- To preview an image the agent read, it reads that file only if it is a regular file of at most 3 MB inside the working directory of the agent whose chat shows the row (a sub-agent's view: its parent's) or the system temp directory (`os.tmpdir()`, plus `/tmp` on macOS). Links are resolved before the check, and the opened file is checked again. A file that does not start like a PNG, JPEG, GIF, WebP or BMP image is not read past its first 32 bytes.
- For Paseo's create agent row, the server part reads the new agent's last 8 timeline entries and sends three short rows while the app is in front and the row on screen. A closed or archived agent is read only when you press Show activity, since reading loads it.
- While a running row is on screen and the app is in front, it subscribes to running agents' updates, so a row turns amber when approval is requested.
- It makes no network requests, starts no processes and reads no credentials; it writes only language templates and state in its plugin data folder. Of the environment it uses PASEO_HOME and HOME for that folder, and TMPDIR and HOME for image checks.
- Installing from Git runs a preparation step that installs two packages from the public npm registry, pinned by the lockfile: Paseo's protocol package and Prism for highlighting.

## Known limits

- Paseo offers each timeline row to plugins in plugin id order; the first to return a result owns it. Plugins that also redraw these rows, such as Beautiful Chat or Colorful Agent Activity, sort earlier and take them, so use only one. A plugin turning tool calls into cards keeps them only if its id sorts first, as Bots does.
- While tool rows are taken over, Paseo's summary mode no longer groups tool calls, file paths cannot be tapped open, and on phones tool details expand in the row instead of a sheet; set takeover to thinking rows only or off to get these back.
- Paseo records only when each step ended, so a row's time starts at the previous step's end.
- Folded and expanded rows are remembered for this session only. After 10 minutes away from an agent, finished steps briefly show unfolded while its timeline is reread.
- Very long code is colored for about 0.1 s; the rest shows plain.
- A sub-agent's own chat view is not folded or timed.
- In the iOS and Android apps a sub-agent card cannot tell if it is visible.
