# Vivid Activity

A [Paseo](https://paseo.sh) plugin that redraws an agent's thinking and tool-call rows as compact,
color-coded activity rows with live states, folds finished runs of steps into one summary row and shows how
long every step took. The interface is in Simplified Chinese.

Based on [Colorful Agent Activity](https://github.com/mcowger/paseo-plugins/tree/e65409bbccf6d07c1bbe24dc8eddd902ee10a769/colorful-agent-activity)
0.3.0 by Matt Cowger (MIT). The layered detail cards take design ideas from
[Beautiful Chat](https://github.com/ABorakati/beautiful-chat) by ABorakati; no code or assets were copied from it.

![Folded runs, a running step and timing in the desktop app](assets/screenshot-desktop-dark.png)

| Detail cards | Phone |
| --- | --- |
| ![Expanded command and edit cards in the light theme](assets/screenshot-details-light.png) | ![A step waiting for approval on a phone](assets/screenshot-phone-dark.png) |

## Features

- **One color per kind of step**: thinking violet, reads blue, edits green, commands orange, searches indigo,
  web requests cyan, sub-agents magenta, MCP tools pink, Paseo tools sky blue. Edits show `+N / −M`.
- **Visible states**: running rows spin and shimmer in blue, rows waiting for your approval pulse in amber, failed
  rows turn red and show a failed command's exit code, and a row that finishes while on screen flashes green once.
  Motion respects the system's reduced motion setting and pauses while the app is in the background.
- **Folding**: when a run of thinking and tool steps has finished it collapses into one row such as
  `8 步 · 读取 2 · 编辑 2 · 命令 2 · 思考 1 · 搜索 1`, with a color bar of the step kinds, a red `失败 1` badge when a
  step failed and the run's total time. Tap it to see the steps again. While the agent works, only running, waiting
  and failed steps and the two most recent ones stay open; earlier steps fold into `前面 N 步`.
- **Timing**: every row shows its duration, running rows count up live, and the fold row shows the elapsed time
  of the whole run.
- **Detail cards**: highlighted commands with output, exit code and copy buttons; file reads with a language
  badge and line numbers; colored diffs; inline previews for images the agent read; dedicated views for Paseo's
  own tools, GitHub and Exa results.
- **Leaves native cards alone**: plan cards, task lists and permission prompts stay with Paseo.

## Settings

The settings page (彩色活动行) offers:

| Setting | Options |
| --- | --- |
| 接管 (takeover) | all rows (default), thinking rows only, off |
| 完成后折叠连续的思考与工具行 (fold finished steps) | on (default), off |
| 行密度 (row density) | compact (default, 4 px between rows), standard (10 px) |
| 调色板 (palette) | vivid (default), follow theme, soft, high contrast |
| 展开方式 (expansion) | per row kind: always, newest only, collapsed |

Settings are stored in Paseo's plugin settings on the daemon, so every connected device uses the same ones.

![The settings page](assets/screenshot-settings-dark.png)

## Data access

The plugin makes no network requests, writes no files and starts no processes.

- The server part reads the projected timeline of the agent you are viewing inside the daemon and returns a
  compact fold index (position, end time, kind, status and category of each row) to the app.
- Image previews read the image file only from the agent's working directory or the system temp directory,
  regular files up to 3 MB, with links resolved before the check (`server/read-image.ts`).
- Expanding a row for Paseo's create agent tool reads the new agent's recent timeline.

[OVERVIEW.md](OVERVIEW.md) lists the details and known limits, including why it cannot be combined with other
plugins that redraw the same rows.

## Install

Requires Paseo 0.11.1 or later. Git installs run the manifest's preparation step,
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, which installs the two runtime packages from the lockfile:
`@getpaseo/protocol` (types and a tool name helper the bundle imports) and `prismjs`.

To try a local checkout, install those packages first, then point Paseo at the folder:

```sh
npm ci --omit=dev --ignore-scripts
paseo plugin install /absolute/path/to/vivid-activity
```

## Development

```sh
npm ci
npm run typecheck
npm test
npm run lint
```

The client entry (`index.client.tsx`) registers the timeline transformers and renderers and the settings
page; the server entry (`index.server.ts`) registers the settings and the `read-image` and `fold-index` RPCs.
See [CHANGELOG.md](CHANGELOG.md) for the changes from Colorful Agent Activity.

## License

MIT. See [LICENSE](LICENSE), which keeps the original copyright notice of Colorful Agent Activity.
