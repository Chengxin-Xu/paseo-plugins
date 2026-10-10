Vivid Activity redraws an agent's thinking and tool-call rows in the chat as compact, color-coded activity rows. Every kind of step has its own color and icon: thinking violet, file reads blue, edits green, commands orange, searches indigo, web requests cyan, sub-agents magenta, MCP tools pink and Paseo's own tools sky blue. Every row also shows its state: a blue spinner while it runs, an amber pulse while it waits for your approval, red when it fails (with the exit code for commands), and a short green flash when it finishes.

When a run of thinking and tool steps has finished, it folds into one summary row with the number of steps, a count per kind, failures and the total time. Tap it to see the steps again. While the agent is still working, only the running, waiting and failed steps and the two most recent ones stay visible. Each row shows how long its step took, and running rows count up live.

The interface is in Simplified Chinese. Based on Colorful Agent Activity by Matt Cowger.

## What the rows show

Expanding a row shows highlighted commands with their output and exit code, file reads with line numbers, colored diffs for edits, previews for images the agent read, and dedicated views for Paseo's own tools (agents, workspaces, terminals, schedules, browser) and for GitHub and Exa results. Plan cards, task lists and permission prompts stay with Paseo.

## Settings

No setup is needed. Requires Paseo 0.11.1 or later. The settings page is titled 彩色活动行:

- Takeover: all rows (default), thinking rows only, or off. A change redraws the open chat right away.
- Fold finished thinking and tool steps: on by default.
- Row density: compact (default, 4 px between rows) or standard (10 px).
- Palette: vivid (default), follow the theme accent, soft, or high contrast.
- Expansion for each kind of row: always, newest only, or collapsed. Reads, edits, writes, commands and questions start collapsed.

Settings are stored in Paseo's plugin settings on the daemon and apply to every device connected to it.

## Data and permissions

- To fold and time rows, the plugin's server part reads the timeline of the agent you are viewing inside the daemon and sends the app a compact index: each row's position, end time, kind, status and category. Tool output is not part of it.
- To preview an image the agent read, it reads that file only if it is inside the working directory of the agent whose chat shows the row (for a sub-agent's own view, its parent agent's) or inside the system temp directory (`os.tmpdir()`, plus `/tmp` on macOS), is a regular file and is at most 3 MB. Links are resolved before the check, and the opened file is checked again. A file that does not start like a PNG, JPEG, GIF, WebP or BMP image is not read past its first 32 bytes. Other images show the agent's text result instead.
- Expanding a row for Paseo's create agent tool shows the new agent's recent activity by reading its timeline. The daemon loads that agent if it was not loaded.
- It watches pending permission requests of the agents on screen to mark the waiting row.
- Copy buttons write to the clipboard when you tap them.
- It makes no network requests, writes no files, starts no processes and reads no credentials or environment variables.
- Installing from Git runs a preparation step that installs two packages from the public npm registry, pinned by the included lockfile: Paseo's protocol package (type definitions and a tool name helper) and Prism for syntax highlighting.

## Known limits

- Paseo offers each timeline row to plugins in order of plugin id, and the first plugin that returns a result owns the row. Plugins that also redraw thinking or tool rows, such as Beautiful Chat or Colorful Agent Activity, come earlier and take those rows, so use only one of them. A plugin that turns certain tool calls into its own cards keeps them only if its id sorts before vivid-activity, as Bots does.
- While tool rows are taken over, Paseo's summary mode for tool calls no longer groups them, file paths cannot be tapped to open the file, and on phones tool details expand in the row instead of a sheet. Set takeover to thinking rows only or off to get these back.
- Paseo records only when each step ended. A row's time runs from the end of the previous step to the end of this one, so it includes the time the model spent writing the call.
- Folded and expanded rows are remembered for the current session only. When you come back to an agent you have not looked at for 10 minutes, its finished steps show unfolded for a moment while the plugin reads its timeline again.
- A sub-agent's own chat view is not folded or timed.
