# Server Browser

Server Browser runs Chromium on your Paseo daemon's machine and shows it inside Paseo on your phone and computer. Every device sees the same live page, and a browser Agent can work on that page through its own tools. A switch shows who is in control: while the Agent has control the page is read-only for you, and once you take over, the Agent can only read the page while you click, scroll, type and navigate.

Each workspace gets its own browser and profile, so logins stay separate and survive restarts. The interface and the browser Agent's instructions are in Simplified Chinese.

## What it adds

- An overview of all workspace browsers, as thumbnails on a computer and a grouped list on a phone, with states such as Agent at work, waiting for approval, login needed and error.
- A browser view with page tabs, an address bar, a typing tray, page size options, a reader that returns the page as Markdown or text, page diagnostics and an activity list.
- Opens from the sidebar, a workspace panel, the Command Center or `/server-browser`.

Pages arrive over Paseo's connection as JPEG frames sized to each screen, not as a video stream.

## Setup

The plugin needs a Linux daemon host and Paseo 0.11.1 or later. It never downloads or installs software by itself. Prepare the host once:

- Run `node scripts/setup-runtime.mjs` in the plugin folder on the daemon host (`paseo plugin ls --json` shows the folder). It installs the locked tree in `runtime-deps/` (Playwright MCP 0.0.82, Mozilla Readability, jsdom, Turndown) into `~/.local/share/paseo-server-browser` or `PASEO_SERVER_BROWSER_RUNTIME` with `npm ci` from the host's npm registry, install scripts disabled. It does not download Chromium.
- Provide Chromium: Playwright's `chromium-headless-shell` in the standard Playwright browser cache, or a Chromium or Chrome binary set in `PASEO_SERVER_BROWSER_EXECUTABLE`.
- Chromium uses the host's libraries and fonts. Missing libraries can go in the runtime's `lib/` folder, and a `fonts.conf` there is used for fonts. Chinese pages need Chinese fonts.

Page diagnostics show whether Chromium, the Agent tools, fonts and proxy settings were found.

## Browser Agent

Connecting a browser Agent creates one Agent in the workspace with the agent profile you choose, gives it one MCP server, `server_browser`, sends it a short setup message, which uses one model turn, and hands it control. Other Agents and Paseo's built-in browser tools are not changed.

`server_browser` is Playwright MCP behind a bridge script that the plugin writes into its data folder from its own source. The bridge refuses writes after you take over, refuses to close the browser, and removes `browser_run_code_unsafe`, which would run arbitrary Node.js code on the host. Other Playwright MCP tools remain, including running JavaScript in the page, filling forms, uploading files from the Agent's workspace, reading console and network requests, and saving screenshots. Tool calls follow the Agent's permission settings. What the Agent reads becomes part of its model conversation.

## Data on the host

Each workspace keeps its data in `~/.local/share/paseo-server-browser/visual/<workspace id>/`, or under `PASEO_SERVER_BROWSER_DATA`, in folders only the daemon user can open:

- `profile/`: the Chromium profile with cookies, logins, history and cache.
- `state.json`: control mode, page size, settings and open tab addresses (HTTP and HTTPS, without credentials), to restore the browser.
- `session.json`: local connection details and a random token for the Agent bridge.
- `artifacts/`: screenshots, snapshots and logs saved by Agent tools. Files older than 48 hours, or beyond 256 MB per workspace, are deleted automatically.

Downloaded files stay in a temporary folder until the browser connection closes. The activity list keeps the last 12 actions in memory, without typed text or URL query strings. Closing a browser or archiving its workspace keeps the profile; to remove logins and history, close the browser and delete the workspace's folder.

The plugin reads the daemon's workspace list and agent profiles to show them. Frames, page titles and addresses go only to your Paseo clients.

## Network and processes

- Chromium runs headless as the daemon user with that user's network access. It opens any HTTP or HTTPS address the host can reach, including `localhost` and private networks, so anyone who can use this daemon can browse from it. Other schemes and addresses with embedded passwords are refused.
- Chromium follows the daemon's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`; `PASEO_SERVER_BROWSER_PROXY` sets a proxy for the browser only. Background networking and component updates are off.
- Processes: one Chromium per running browser, plus a Node.js bridge and Playwright MCP per browser Agent session.
- Chromium's debugging port and the plugin's control endpoint listen on 127.0.0.1 only. The control endpoint needs the token from `session.json`, but the debugging port has no authentication, so other users and processes on the host can attach to the browser. Use it on a host you do not share.
- Chromium runs without its own sandbox, as Playwright does by default. Set `PASEO_SERVER_BROWSER_SANDBOX=1` where the sandbox is supported.
- After a crash the browser restarts, at most 3 times in 5 minutes, and reopens saved pages without repeating clicks, typing or form submissions.

## Limits

- Linux only; tested on x86-64 with Chromium headless shell. One browser Agent per workspace browser.
- No download manager, audio, video, clipboard sync or full keyboard shortcut mapping.
- Single sign-on, captchas and sites that block servers need checking per site.
- A crash can lose unsaved cookies, unsent forms and in-page state.
